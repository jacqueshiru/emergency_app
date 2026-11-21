import * as store from './tokenStore';
import { isNative } from './platform';

/**
 * Emergency contacts kept on the phone so an SOS can be texted with no internet.
 * Native app only (Keystore-backed storage); the browser build never keeps this copy.
 */
export type CachedContactTier = 'CRITICAL' | 'EVERYDAY';

export interface CachedContact {
  id: string;
  name: string;
  phoneNumber: string;
  relationship: string | null;
  tier: CachedContactTier;
}

const KEY = 'seas_contacts';

export function saveContacts(list: CachedContact[]): void {
  if (!isNative) return;
  store.setItem(
    KEY,
    JSON.stringify(list.map((c) => ({ id: c.id, name: c.name, phoneNumber: c.phoneNumber, relationship: c.relationship, tier: c.tier ?? 'EVERYDAY' })))
  );
}

export function loadContacts(): CachedContact[] {
  try {
    const parsed = JSON.parse(store.getItem(KEY) || '[]');
    return Array.isArray(parsed)
      ? parsed.map((c: any) => ({ ...c, tier: c.tier === 'CRITICAL' ? 'CRITICAL' : 'EVERYDAY' }))
      : [];
  } catch {
    return [];
  }
}

export function clearContacts(): void {
  store.removeItem(KEY);
}
