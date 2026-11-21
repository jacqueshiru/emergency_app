import { Capacitor, type PluginListenerHandle } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Haptics } from '@capacitor/haptics';
import { Network } from '@capacitor/network';
import { App } from '@capacitor/app';

/** Thin wrapper so pages use native plugins in the Android app and web APIs in a browser. */
export const isNative = Capacitor.isNativePlatform();

export interface DevicePosition {
  latitude: number;
  longitude: number;
  accuracy: number | null;
}

export async function getPosition(timeoutMs: number, maximumAgeMs: number): Promise<DevicePosition> {
  if (isNative) {
    let perm = await Geolocation.checkPermissions();
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      perm = await Geolocation.requestPermissions({ permissions: ['location'] });
    }
    if (perm.location !== 'granted' && perm.coarseLocation !== 'granted') {
      throw new Error('Location permission denied');
    }
    const pos = await Geolocation.getCurrentPosition({
      enableHighAccuracy: true,
      timeout: timeoutMs,
      maximumAge: maximumAgeMs,
    });
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy ?? null };
  }

  return new Promise<DevicePosition>((resolve, reject) => {
    if (!('geolocation' in navigator)) return reject(new Error('Geolocation unsupported'));
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ latitude: p.coords.latitude, longitude: p.coords.longitude, accuracy: p.coords.accuracy ?? null }),
      (e) => reject(e),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: maximumAgeMs }
    );
  });
}

/** Immediate physical confirmation that the hold gesture registered. */
export async function confirmHaptic(): Promise<void> {
  try {
    if (isNative) await Haptics.vibrate({ duration: 300 });
    else navigator.vibrate?.([120, 60, 120]);
  } catch {
    // Haptics are a nicety, never a failure.
  }
}

function listen(add: () => Promise<PluginListenerHandle>): () => void {
  let handle: PluginListenerHandle | undefined;
  let removed = false;
  add().then((h) => {
    if (removed) void h.remove();
    else handle = h;
  }).catch(() => {});
  return () => {
    removed = true;
    if (handle) void handle.remove();
  };
}

/** Calls cb whenever connectivity comes back. Native event is more reliable than window 'online'. */
export function onReconnect(cb: () => void): () => void {
  if (isNative) {
    return listen(() => Network.addListener('networkStatusChange', (s) => { if (s.connected) cb(); }));
  }
  window.addEventListener('online', cb);
  return () => window.removeEventListener('online', cb);
}

/** Calls cb when the app returns to the foreground. */
export function onResume(cb: () => void): () => void {
  if (isNative) {
    return listen(() => App.addListener('appStateChange', (s) => { if (s.isActive) cb(); }));
  }
  const onVisible = () => { if (document.visibilityState === 'visible') cb(); };
  window.addEventListener('focus', cb);
  document.addEventListener('visibilitychange', onVisible);
  return () => {
    window.removeEventListener('focus', cb);
    document.removeEventListener('visibilitychange', onVisible);
  };
}
