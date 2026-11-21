/**
 * Redacting Logger
 * Non-negotiable constraint: Logs redact phone numbers, OTPs, tokens and coordinates.
 */

function redactSensitiveData(input: any): any {
  if (input === null || input === undefined) return input;

  if (typeof input === 'string') {
    let sanitized = input;
    // Redact JWT tokens (Bearer ... or eyJ...)
    sanitized = sanitized.replace(/Bearer\s+[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g, 'Bearer [REDACTED_TOKEN]');
    sanitized = sanitized.replace(/eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.?[A-Za-z0-9-_.+/=]*/g, '[REDACTED_JWT]');

    // Redact phone numbers (+254... or 07... or 01... with 9-13 digits)
    sanitized = sanitized.replace(/(\+?[1-9]\d{1,2})(\d{3,})(\d{3})/g, (_m, prefix, _mid, last) => `${prefix}***${last}`);

    return sanitized;
  }

  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item));
  }

  if (typeof input === 'object') {
    const copy: Record<string, any> = {};
    for (const [key, value] of Object.entries(input)) {
      const lowerKey = key.toLowerCase();
      if (lowerKey.includes('otp') || lowerKey.includes('code') || lowerKey === 'codehash') {
        copy[key] = '[REDACTED_OTP]';
      } else if (lowerKey.includes('token') || lowerKey.includes('secret') || lowerKey.includes('password') || lowerKey === 'tokenhash') {
        copy[key] = '[REDACTED_CREDENTIAL]';
      } else if (lowerKey === 'latitude' || lowerKey === 'longitude' || lowerKey === 'coordinates') {
        copy[key] = '[REDACTED_LOCATION]';
      } else if (lowerKey.includes('phone') && typeof value === 'string') {
        copy[key] = value.replace(/(\+?[1-9]\d{1,2})(\d{3,})(\d{3})/, '$1***$3');
      } else {
        copy[key] = redactSensitiveData(value);
      }
    }
    return copy;
  }

  return input;
}

export const logger = {
  info: (message: string, meta?: any) => {
    const safeMeta = meta !== undefined ? redactSensitiveData(meta) : '';
    console.log(`[INFO] ${new Date().toISOString()} - ${message}`, safeMeta ? JSON.stringify(safeMeta) : '');
  },
  warn: (message: string, meta?: any) => {
    const safeMeta = meta !== undefined ? redactSensitiveData(meta) : '';
    console.warn(`[WARN] ${new Date().toISOString()} - ${message}`, safeMeta ? JSON.stringify(safeMeta) : '');
  },
  error: (message: string, meta?: any) => {
    const safeMeta = meta !== undefined ? redactSensitiveData(meta) : '';
    console.error(`[ERROR] ${new Date().toISOString()} - ${message}`, safeMeta ? JSON.stringify(safeMeta) : '');
  },
  debug: (message: string, meta?: any) => {
    if (process.env.NODE_ENV !== 'production') {
      const safeMeta = meta !== undefined ? redactSensitiveData(meta) : '';
      console.log(`[DEBUG] ${new Date().toISOString()} - ${message}`, safeMeta ? JSON.stringify(safeMeta) : '');
    }
  },
  redact: redactSensitiveData,
};
