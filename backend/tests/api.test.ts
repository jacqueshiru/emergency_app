import { describe, it, expect } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { config } from '../src/config';
import { Role } from '@seas/shared';

const app = createApp();

describe('SEAS API Integration Tests', () => {
  it('GET /health returns 200 with status ok', async () => {
    const res = await request(app).get('/health');
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.service).toBe('seas-backend');
    expect(typeof res.body.uptime).toBe('number');
  });

  it('GET /contacts requires authentication (401)', async () => {
    const res = await request(app).get('/contacts');
    expect(res.status).toBe(401);
    expect(res.body.error).toContain('Authentication required');
  });

  it('GET /alerts requires authentication (401)', async () => {
    const res = await request(app).get('/alerts');
    expect(res.status).toBe(401);
  });

  it('GET /admin/alerts rejects regular USER (403)', async () => {
    const regularUserToken = jwt.sign(
      { id: 'user-1', role: Role.USER, phoneNumber: '+254711111111' },
      config.jwt.secret
    );

    const res = await request(app)
      .get('/admin/alerts')
      .set('Authorization', `Bearer ${regularUserToken}`);

    expect(res.status).toBe(403);
    expect(res.body.error).toContain('Administrator privileges required');
  });

  it('POST /webhooks/africastalking/delivery rejects request missing provider id (400)', async () => {
    const res = await request(app)
      .post('/webhooks/africastalking/delivery')
      .set('x-webhook-secret', 'test-webhook-secret')
      .send({ status: 'Success' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Missing provider message id');
  });
});