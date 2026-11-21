import { Capacitor } from '@capacitor/core';
import { SecureStorage } from '@aparajita/capacitor-secure-storage';

/**
 * Session storage.
 *  - Android app: values live in the Android Keystore-backed secure storage; reads come from an
 *    in-memory cache that is filled once at startup (initTokenStore), so the rest of the app can
 *    keep using synchronous getItem().
 *  - Browser: plain localStorage, as before.
 */
const native = Capacitor.isNativePlatform();
const KEYS = ['seas_access_token', 'seas_refresh_token', 'seas_user', 'seas_contacts'];
const cache = new Map<string, string>();
let ready: Promise<void> | null = null;

export function initTokenStore(): Promise<void> {
  if (!native) return Promise.resolve();
  if (!ready) {
    ready = (async () => {
      for (const key of KEYS) {
        try {
          const value = await SecureStorage.getItem(key);
          if (value) cache.set(key, value);
        } catch {
          // Unreadable entry: behave as logged out for that key.
        }
      }
    })();
  }
  return ready;
}

export function getItem(key: string): string | null {
  return native ? cache.get(key) ?? null : localStorage.getItem(key);
}

export function setItem(key: string, value: string): void {
  if (native) {
    cache.set(key, value);
    void SecureStorage.setItem(key, value).catch(() => {});
  } else {
    localStorage.setItem(key, value);
  }
}

export function removeItem(key: string): void {
  if (native) {
    cache.delete(key);
    void SecureStorage.removeItem(key).catch(() => {});
  } else {
    localStorage.removeItem(key);
  }
}
