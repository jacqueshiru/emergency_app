import { describe, it, expect } from 'vitest';
import { normalizePhoneNumber, isValidPhoneNumber } from '../src/utils/phone';

describe('Phone Normalization (E.164)', () => {
  it('normalizes Kenyan local 07xx numbers to +254', () => {
    const normalized = normalizePhoneNumber('0712345678');
    expect(normalized).toBe('+254712345678');
  });

  it('normalizes Kenyan local 01xx numbers to +254', () => {
    const normalized = normalizePhoneNumber('0112345678');
    expect(normalized).toBe('+254112345678');
  });

  it('normalizes 254 without leading plus', () => {
    const normalized = normalizePhoneNumber('254712345678');
    expect(normalized).toBe('+254712345678');
  });

  it('accepts valid international E.164 numbers', () => {
    const normalized = normalizePhoneNumber('+14155552671');
    expect(normalized).toBe('+14155552671');
  });

  it('rejects invalid numbers', () => {
    expect(() => normalizePhoneNumber('12345')).toThrow();
    expect(isValidPhoneNumber('abc1234')).toBe(false);
  });
});
