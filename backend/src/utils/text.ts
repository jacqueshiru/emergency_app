/**
 * Cleans user-supplied display text before it is stored or placed in an SMS:
 * removes control / zero-width / bidi-override characters, strips links, collapses
 * whitespace and truncates. Prevents SMS spoofing and using the app to relay links.
 */
export function sanitizeDisplayName(input: unknown, max = 40): string {
  if (typeof input !== 'string') return '';
  let s = input.replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ');
  s = s.replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ');
  s = s.replace(/\s+/g, ' ').trim();
  return s.slice(0, max).trim();
}
