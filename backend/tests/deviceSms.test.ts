import { describe, it, expect, afterEach, vi } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { prisma } from '../src/prisma';
import { config } from '../src/config';
import { smsService } from '../src/services/sms';
import { runDeliveryPass } from '../src/services/deliveryWorker';
import { Role } from '@seas/shared';

const app = createApp();

async function makeUserWithContacts(phone: string, contactPhones: string[]) {
  const user = await prisma.user.create({ data: { phoneNumber: phone, name: 'Dev Tester', role: Role.USER } });
  const contacts = [];
  for (const [i, cp] of contactPhones.entries()) {
    contacts.push(await prisma.emergencyContact.create({ data: { userId: user.id, name: `C${i + 1}`, phoneNumber: cp } }));
  }
  const token = jwt.sign({ id: user.id, role: user.role, phoneNumber: phone }, config.jwt.secret, { expiresIn: '15m' });
  return { user, contacts, auth: { Authorization: `Bearer ${token}` } };
}

describe('alerts sent from the phone (device SMS)', () => {
  let sendSpy: ReturnType<typeof vi.spyOn> | undefined;
  afterEach(() => { sendSpy?.mockRestore(); sendSpy = undefined; });

  it('records per-contact results and does not send SMS from the server', async () => {
    sendSpy = vi.spyOn(smsService, 'sendSms');
    const { contacts, auth } = await makeUserWithContacts('+254755000001', ['+254711900001', '+254711900002']);

    const res = await request(app).post('/alerts').set(auth).send({
      idempotencyKey: 'dev-1', locationAvailable: false, sentByDevice: true,
      deviceDeliveries: [
        { contactId: contacts[0].id, status: 'SENT' },
        { contactId: contacts[1].id, status: 'FAILED', error: 'No mobile service' },
      ],
    });
    expect(res.status).toBe(201);
    const byContact = Object.fromEntries(res.body.deliveries.map((d: any) => [d.contactId, d]));
    expect(byContact[contacts[0].id].status).toBe('SENT');
    expect(byContact[contacts[0].id].channel).toBe('device-sms');
    expect(byContact[contacts[1].id].status).toBe('FAILED');
    expect(byContact[contacts[1].id].lastErrorCode).toBe('No mobile service');
    expect(res.body.status).toBe('PROCESSING'); // one SMS still awaiting delivery

    await runDeliveryPass();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('marks contacts the phone did not text as FAILED, and COMPLETES when nothing is pending', async () => {
    const { contacts, auth } = await makeUserWithContacts('+254755000002', ['+254711900003', '+254711900004']);
    const res = await request(app).post('/alerts').set(auth).send({
      idempotencyKey: 'dev-2', locationAvailable: false, sentByDevice: true,
      deviceDeliveries: [{ contactId: contacts[0].id, status: 'DELIVERED' }], // contact 2 missing
    });
    expect(res.status).toBe(201);
    const missing = res.body.deliveries.find((d: any) => d.contactId === contacts[1].id);
    expect(missing.status).toBe('FAILED');
    expect(missing.lastErrorCode).toMatch(/Not sent from the phone/);
    expect(res.body.status).toBe('COMPLETED');
  });

  it('ignores unknown contact ids and is not blocked by an already-open alert', async () => {
    const { contacts, auth } = await makeUserWithContacts('+254755000003', ['+254711900005']);
    const first = await request(app).post('/alerts').set(auth).send({ idempotencyKey: 'srv-1', locationAvailable: false });
    expect(first.status).toBe(201); // server-sent, stays OPEN

    const res = await request(app).post('/alerts').set(auth).send({
      idempotencyKey: 'dev-3', locationAvailable: false, sentByDevice: true,
      deviceDeliveries: [
        { contactId: contacts[0].id, status: 'SENT' },
        { contactId: 'not-a-real-contact', status: 'SENT' },
      ],
    });
    expect(res.status).toBe(201);
    expect(res.body.deliveries).toHaveLength(1);
  });

  it('replays the same idempotency key without duplicating', async () => {
    const { contacts, auth } = await makeUserWithContacts('+254755000004', ['+254711900006']);
    const body = {
      idempotencyKey: 'dev-4', locationAvailable: false, sentByDevice: true,
      deviceDeliveries: [{ contactId: contacts[0].id, status: 'SENT' }],
    };
    const a = await request(app).post('/alerts').set(auth).send(body);
    const b = await request(app).post('/alerts').set(auth).send(body);
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
  });
});

describe('POST /alerts/:id/device-reports', () => {
  async function deviceAlert(phone: string, contactPhones: string[]) {
    const u = await makeUserWithContacts(phone, contactPhones);
    const res = await request(app).post('/alerts').set(u.auth).send({
      idempotencyKey: `rep-${phone.replace(/\D/g, '')}`, locationAvailable: false, sentByDevice: true,
      deviceDeliveries: u.contacts.map((c) => ({ contactId: c.id, status: 'SENT' })),
    });
    expect(res.status).toBe(201); // the helper must really create the alert
    return { ...u, alert: res.body };
  }

  it('upgrades SENT to DELIVERED and completes the alert once nothing is pending', async () => {
    const { contacts, auth, alert } = await deviceAlert('+254755000005', ['+254711900007']);
    const res = await request(app).post(`/alerts/${alert.id}/device-reports`).set(auth)
      .send({ reports: [{ contactId: contacts[0].id, status: 'DELIVERED' }] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    const after = await request(app).get(`/alerts/${alert.id}`).set(auth);
    expect(after.body.deliveries[0].status).toBe('DELIVERED');
    expect(after.body.status).toBe('COMPLETED');
  });

  it("returns 404 for another user's alert and rejects malformed bodies", async () => {
    const owner = await deviceAlert('+254755000006', ['+254711900008']);
    const other = await makeUserWithContacts('+254755000007', ['+254711900009']);
    const body = { reports: [{ contactId: owner.contacts[0].id, status: 'DELIVERED' }] };
    expect((await request(app).post(`/alerts/${owner.alert.id}/device-reports`).set(other.auth).send(body)).status).toBe(404);
    expect((await request(app).post(`/alerts/${owner.alert.id}/device-reports`).set(owner.auth).send({ reports: [] })).status).toBe(400);
    const stillSent = await prisma.alertDelivery.findFirst({ where: { alertId: owner.alert.id } });
    expect(stillSent?.status).toBe('SENT');
  });

  it('cannot alter deliveries the server sent', async () => {
    const { contacts, auth } = await makeUserWithContacts('+254755000008', ['+254711900010']);
    const srv = await request(app).post('/alerts').set(auth).send({ idempotencyKey: 'srv-rep-1', locationAvailable: false });
    const res = await request(app).post(`/alerts/${srv.body.id}/device-reports`).set(auth)
      .send({ reports: [{ contactId: contacts[0].id, status: 'DELIVERED' }] });
    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });
});