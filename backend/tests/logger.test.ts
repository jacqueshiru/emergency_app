import { describe, it, expect } from 'vitest';
import { logger } from '../src/utils/logger';

describe('Logger Redaction', () => {
  it('redacts phone numbers in objects', () => {
    const data = { phoneNumber: '+254712345678', name: 'John Doe' };
    const redacted = logger.redact(data);
    expect(redacted.phoneNumber).toBe('+254***678');
    expect(redacted.name).toBe('John Doe');
  });

  it('redacts OTP codes and hashes', () => {
    const data = { otp: '123456', codeHash: 'secret-hash' };
    const redacted = logger.redact(data);
    expect(redacted.otp).toBe('[REDACTED_OTP]');
    expect(redacted.codeHash).toBe('[REDACTED_OTP]');
  });

  it('redacts access tokens and refresh tokens', () => {
    const data = { token: 'eyJhbGciOi...', refreshToken: 'abcdef123456' };
    const redacted = logger.redact(data);
    expect(redacted.token).toBe('[REDACTED_CREDENTIAL]');
    expect(redacted.refreshToken).toBe('[REDACTED_CREDENTIAL]');
  });

  it('redacts latitude and longitude coordinates', () => {
    const data = { latitude: -1.2921, longitude: 36.8219 };
    const redacted = logger.redact(data);
    expect(redacted.latitude).toBe('[REDACTED_LOCATION]');
    expect(redacted.longitude).toBe('[REDACTED_LOCATION]');
  });

  it('redacts bearer tokens in string messages', () => {
    const message = 'Request header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.abcdef';
    const redacted = logger.redact(message);
    expect(redacted).toContain('Bearer [REDACTED_TOKEN]');
    expect(redacted).not.toContain('eyJhbGci');
  });
});
