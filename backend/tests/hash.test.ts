import { describe, it, expect } from 'vitest';
import { hashToken, generateOtp, generateRefreshToken } from '../src/utils/hash';

describe('Credential Hashing and Token Generation', () => {
  it('hashes tokens deterministically with salt', () => {
    const raw = 'test-token-123';
    const hash1 = hashToken(raw);
    const hash2 = hashToken(raw);
    expect(hash1).toBe(hash2);
    expect(hash1).not.toBe(raw);
    expect(hash1.length).toBe(64); // SHA-256 hex length
  });

  it('generates a 6-digit numeric OTP', () => {
    const otp = generateOtp();
    expect(otp).toMatch(/^\d{6}$/);
    const num = parseInt(otp, 10);
    expect(num).toBeGreaterThanOrEqual(100000);
    expect(num).toBeLessThanOrEqual(999999);
  });

  it('generates a cryptographically strong refresh token', () => {
    const token = generateRefreshToken();
    expect(token).toHaveLength(80); // 40 bytes in hex
  });
});
