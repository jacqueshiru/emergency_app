import crypto from 'crypto';

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateTotpSecret(bytes = 20): string {
  const raw = crypto.randomBytes(bytes);
  let bits = '';
  for (const b of raw) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) {
    const chunk = bits.slice(i, i + 5);
    out += alphabet[parseInt(chunk.padEnd(5, '0'), 2)];
  }
  return out;
}

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = '';
  for (const c of clean) bits += alphabet.indexOf(c).toString(2).padStart(5, '0');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function verifyTotp(secret: string, code: string, step = 30, digits = 6): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  const counter = Math.floor(Date.now() / 1000 / step);
  for (const offset of [-1, 0, 1]) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(counter + offset));
    const mac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest();
    const pos = mac[mac.length - 1] & 0xf;
    const binary = ((mac[pos] & 0x7f) << 24) | ((mac[pos + 1] & 0xff) << 16) | ((mac[pos + 2] & 0xff) << 8) | (mac[pos + 3] & 0xff);
    const expected = (binary % (10 ** digits)).toString().padStart(digits, '0');
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(code))) return true;
  }
  return false;
}
