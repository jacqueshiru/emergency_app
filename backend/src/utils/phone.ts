import { PhoneNumberUtil, PhoneNumberFormat } from 'google-libphonenumber';

const phoneUtil = PhoneNumberUtil.getInstance();

/**
 * Normalizes phone numbers to standard E.164 format (+254712345678).
 * Defaults to Kenya (KE) for national numbers like 0712345678 or 0112345678.
 */
export function normalizePhoneNumber(rawPhone: string, defaultRegion = 'KE'): string {
  if (!rawPhone || typeof rawPhone !== 'string') {
    throw new Error('Phone number is required');
  }

  const trimmed = rawPhone.trim();

  try {
    const parsed = phoneUtil.parseAndKeepRawInput(trimmed, defaultRegion);
    if (!phoneUtil.isValidNumber(parsed)) {
      throw new Error(`Invalid phone number: ${rawPhone}`);
    }
    return phoneUtil.format(parsed, PhoneNumberFormat.E164);
  } catch (error: any) {
    throw new Error(`Phone normalization failed: ${error.message || 'Invalid format'}`);
  }
}

export function isValidPhoneNumber(rawPhone: string, defaultRegion = 'KE'): boolean {
  try {
    const parsed = phoneUtil.parseAndKeepRawInput(rawPhone.trim(), defaultRegion);
    return phoneUtil.isValidNumber(parsed);
  } catch {
    return false;
  }
}
