import { describe, it, expect, afterEach } from 'vitest';
import request from 'supertest';
import { createApp } from '../src/app';
import { config, smsConfig } from '../src/config';
import { smsService } from '../src/services/sms';

const saved = { env: config.env, provider: smsConfig.provider, key: config.africasTalking.apiKey, flag: process.env.ALLOW_DEV_OTP };
afterEach(() => {
  config.env = saved.env;
  smsConfig.provider = saved.provider;
  config.africasTalking.apiKey = saved.key;
  (smsService as any).apiKey = saved.key;
  if (saved.flag === undefined) delete process.env.ALLOW_DEV_OTP; else process.env.ALLOW_DEV_OTP = saved.flag;
});

describe('no silent fake SMS success', () => {
  it('fails honestly when no provider is configured', async () => {
    smsConfig.provider = 'africastalking';
    (smsService as any).apiKey = '';
    const res = await smsService.sendSms('+254700000333', 'x');
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/No SMS provider/);
  });

  it('only simulates when SMS_PROVIDER=mock is set explicitly', async () => {
    smsConfig.provider = 'mock';
    (smsService as any).apiKey = '';
    const res = await smsService.sendSms('+254700000333', 'x');
    expect(res.success).toBe(true);
    expect(res.messageId).toMatch(/^mock-msg-/);
  });

  it('login code request reports failure instead of "code sent" when the SMS could not go out', async () => {
    config.env = 'development';
    delete process.env.ALLOW_DEV_OTP;
    smsConfig.provider = 'africastalking';
    config.africasTalking.apiKey = '';
    (smsService as any).apiKey = '';
    const res = await request(createApp()).post('/auth/otp/request').send({ phoneNumber: '0711555001' });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe('OTP_SMS_FAILED');
    expect(res.body.devCode).toBeUndefined();
  });

  it('dev login still works when explicitly allowed and no provider exists', async () => {
    config.env = 'development';
    process.env.ALLOW_DEV_OTP = 'true';
    smsConfig.provider = 'africastalking';
    config.africasTalking.apiKey = '';
    (smsService as any).apiKey = '';
    const res = await request(createApp()).post('/auth/otp/request').send({ phoneNumber: '0711555002' });
    expect(res.status).toBe(200);
    expect(res.body.devCode).toMatch(/^\d{6}$/);
  });
});
