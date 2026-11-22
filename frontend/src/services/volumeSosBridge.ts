/**
 * Bridges the native triple-volume SOS event to whatever page currently owns
 * the trigger logic (SosPage). The accessibility service can fire while the
 * user is on Contacts/Admin/etc.; we keep a single always-on listener in App
 * and hand off to SosPage when it is mounted (or as soon as it mounts).
 */

type Handler = () => void;

let handler: Handler | null = null;
let pending = false;

/** SosPage registers its CRITICAL trigger here. Returns an unregister function. */
export function setVolumeSosHandler(h: Handler | null): () => void {
  handler = h;
  if (h && pending) {
    pending = false;
    try {
      h();
    } catch {
      // never let a handler exception kill the bridge
    }
  }
  return () => {
    if (handler === h) handler = null;
  };
}

/**
 * Called from the always-mounted App listener when the native plugin emits
 * volumeSos. If SosPage is already registered, fire immediately; otherwise
 * remember that a volume SOS is waiting so it runs as soon as SosPage mounts.
 */
export function requestVolumeSos(): void {
  if (handler) {
    try {
      handler();
    } catch {
      // ignore
    }
  } else {
    pending = true;
  }
}

/** True when a volume SOS arrived before SosPage was ready (e.g. other route). */
export function hasPendingVolumeSos(): boolean {
  return pending;
}
