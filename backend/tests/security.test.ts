import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { prisma } from '../src/prisma';
import { config, smsConfig, devOtpAllowed, allowedOrigins, securityProblems, corsOriginOption } from '../src/config';
import { sanitizeDisplayName } from '../src/utils/text';
import { Role } from '@seas/shared';

const app = createApp();

async function makeUser(phone: string, role: Role = Role.USER) {
  const user = await prisma.user.create({ data: { phoneNumber: phone, name: 'Sec Tester', role } });
  const token = jwt.sign({ id: user.id, role: user.role, phoneNumber: phone }, config.jwt.secret, { expiresIn: '15m' });
  return { user, token, auth: { Authorization: `Bearer ${token}` } };
}

describe('sanitizeDisplayName', () => {
  it('strips links, control and bidi characters, and truncates', () => {
    expect(sanitizeDisplayName('Mum http://evil.example/x')).toBe('Mum');
    expect(sanitizeDisplayName('Click www.evil.example now')).toBe('Click now');
    expect(sanitizeDisplayName('A\u202Eevil\u0000name')).toBe('A evil name');
    expect(sanitizeDisplayName('x'.repeat(100), 40)).toHaveLength(40);
    expect(sanitizeDisplayName(undefined)).toBe('');
  });
});

describe('devOtpAllowed (OTP must never leak by accident)', () => {
  const saved = {
    env: config.env, provider: smsConfig.provider, key: config.africasTalking.apiKey, flag: process.env.ALLOW_DEV_OTP,
  };
  afterEach(() => {
    config.env = saved.env;
    smsConfig.provider = saved.provider;
    config.africasTalking.apiKey = saved.key;
    if (saved.flag === undefined) delete process.env.ALLOW_DEV_OTP; else process.env.ALLOW_DEV_OTP = saved.flag;
  });

  it('is off in development unless ALLOW_DEV_OTP=true', () => {
    config.env = 'development'; smsConfig.provider = 'africastalking'; config.africasTalking.apiKey = '';
    delete process.env.ALLOW_DEV_OTP;
    expect(devOtpAllowed()).toBe(false);
    process.env.ALLOW_DEV_OTP = 'true';
    expect(devOtpAllowed()).toBe(true);
  });

  it('is always off when a real SMS provider is configured', () => {
    config.env = 'development'; process.env.ALLOW_DEV_OTP = 'true';
    smsConfig.provider = 'gateway';
    expect(devOtpAllowed()).toBe(false);
    smsConfig.provider = 'africastalking'; config.africasTalking.apiKey = 'real-key';
    expect(devOtpAllowed()).toBe(false);
  });

  it('is always off in production', () => {
    config.env = 'production'; smsConfig.provider = 'africastalking'; config.africasTalking.apiKey = '';
    process.env.ALLOW_DEV_OTP = 'true';
    expect(devOtpAllowed()).toBe(false);
  });
});

describe('production configuration guard', () => {
  it('flags default secrets, wildcard CORS, dev OTP flag and missing webhook secret', () => {
    const problems = securityProblems({ JWT_SECRET: 'dev-jwt-secret-replace-in-production-seas', CORS_ORIGIN: '*', ALLOW_DEV_OTP: 'true' } as any);
    const text = problems.join(' | ');
    expect(text).toMatch(/JWT_SECRET/);
    expect(text).toMatch(/CORS_ORIGIN/);
    expect(text).toMatch(/ALLOW_DEV_OTP/);
    expect(text).toMatch(/WEBHOOK_SECRET/);
  });

  it('reports nothing for a sound configuration', () => {
    const prev = smsConfig.provider;
    smsConfig.provider = 'gateway';
    try {
      const problems = securityProblems({
        JWT_SECRET: 'a'.repeat(48), CORS_ORIGIN: 'https://app.example.com', WEBHOOK_SECRET: 'b'.repeat(24),
      } as any);
      expect(problems).toEqual([]);
    } finally { smsConfig.provider = prev; }
  });

  it('parses CORS origins', () => {
    const prev = config.corsOrigin;
    try {
      config.corsOrigin = 'https://a.example, https://b.example';
      expect(allowedOrigins()).toEqual(['https://a.example', 'https://b.example']);
      config.corsOrigin = '*';
      expect(allowedOrigins()).toBe(true);
    } finally { config.corsOrigin = prev; }
  });
});

describe('API hardening', () => {
  it('rejects tokens signed with a different algorithm', async () => {
    const { user } = await makeUser('+254744100001');
    const bad = jwt.sign({ id: user.id, role: 'USER', phoneNumber: user.phoneNumber }, config.jwt.secret, { algorithm: 'HS512' });
    const res = await request(app).get('/contacts').set('Authorization', `Bearer ${bad}`);
    expect(res.status).toBe(401);
  });

  it('caps contacts per user and strips links from names', async () => {
    const { auth } = await makeUser('+254744100002');
    const add = (n: number, name = 'Friend') =>
      request(app).post('/contacts').set(auth).send({ name, phoneNumber: `07110000${String(n).padStart(2, '0')}` });

    const linked = await add(1, 'Mum http://evil.example/x');
    expect(linked.status).toBe(201);
    expect(linked.body.name).toBe('Mum');
    expect((await add(2, 'https://only-a-link.example')).status).toBe(400);

    for (let n = 3; n <= 11; n++) expect((await add(n)).status).toBe(201); // 10 total
    const over = await add(12);
    expect(over.status).toBe(400);
    expect(over.body.code).toBe('CONTACT_LIMIT');
  });

  it("won't let another user update or delete a contact", async () => {
    const a = await makeUser('+254744100003');
    const b = await makeUser('+254744100004');
    const created = await request(app).post('/contacts').set(a.auth).send({ name: 'Own', phoneNumber: '0711000099' });
    const id = created.body.id;
    expect((await request(app).patch(`/contacts/${id}`).set(b.auth).send({ name: 'Hacked' })).status).toBe(404);
    expect((await request(app).delete(`/contacts/${id}`).set(b.auth)).status).toBe(404);
    expect((await prisma.emergencyContact.findUnique({ where: { id } }))?.name).toBe('Own');
  });

  it('validates idempotencyKey format and out-of-range coordinates without blocking the SOS', async () => {
    const { auth } = await makeUser('+254744100005');
    await request(app).post('/contacts').set(auth).send({ name: 'C', phoneNumber: '0711000098' });

    const badKey = await request(app).post('/alerts').set(auth).send({ idempotencyKey: 'has spaces <script>', locationAvailable: false });
    expect(badKey.status).toBe(400);

    const res = await request(app).post('/alerts').set(auth).send({
      idempotencyKey: 'sec-coords-1', latitude: 999, longitude: 12, locationAvailable: true,
    });
    expect(res.status).toBe(201);
    expect(res.body.locationAvailable).toBe(false);
    expect(res.body.latitude).toBeNull();
  });

  it('admin alert listing honours the page-size limit', async () => {
    const admin = await makeUser('+254744100006', Role.ADMIN);
    const u = await makeUser('+254744100007');
    for (let i = 0; i < 3; i++) {
      await prisma.alert.create({ data: { userId: u.user.id, idempotencyKey: `adm-${i}-${Math.random()}`, locationAvailable: false } });
    }
    const res = await request(app).get('/admin/alerts?limit=2').set(admin.auth);
    expect(res.status).toBe(200);
    expect(res.body.length).toBeLessThanOrEqual(2);
  });
});

describe('CORS origins for the Android app', () => {
  it('always adds the native WebView origins to an explicit list, and leaves "*" alone', () => {
    const prev = config.corsOrigin;
    try {
      config.corsOrigin = 'https://web.example';
      const list = corsOriginOption() as string[];
      expect(list).toContain('https://web.example');
      expect(list).toContain('https://localhost');
      expect(list).toContain('capacitor://localhost');
      config.corsOrigin = '*';
      expect(corsOriginOption()).toBe(true);
    } finally { config.corsOrigin = prev; }
  });
});
