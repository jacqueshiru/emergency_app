import { Capacitor, registerPlugin, type PluginListenerHandle, type PermissionState } from '@capacitor/core';

/** Binding for the custom Android plugin SmsSenderPlugin (frontend/android/.../SmsSenderPlugin.java). */
export interface SmsSendResult {
  id: string;
  /** sent = the phone's radio accepted every part; unknown = no result within 20s; failed = see error */
  status: 'sent' | 'failed' | 'unknown';
  error?: string;
}
export interface SmsDeliveryEvent {
  id: string;
  status: 'delivered' | 'failed';
}

interface SmsSenderPlugin {
  isAvailable(): Promise<{ available: boolean; reason?: string }>;
  checkPermissions(): Promise<{ sms: PermissionState }>;
  requestPermissions(options?: { permissions: Array<'sms'> }): Promise<{ sms: PermissionState }>;
  send(options: { id: string; to: string; message: string }): Promise<SmsSendResult>;
  pickContact(): Promise<{ name: string; phoneNumber: string }>;
  dial(options: { number: string }): Promise<{ opened: boolean }>;
  addListener(
    eventName: 'smsDelivery',
    listener: (event: SmsDeliveryEvent) => void
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'volumeSos',
    listener: (event: { timestamp: number }) => void
  ): Promise<PluginListenerHandle>;
}

export const smsSenderSupported = Capacitor.getPlatform() === 'android';
export const smsSender = registerPlugin<SmsSenderPlugin>('SmsSender');

/** Subscribe to carrier delivery reports. Returns an unsubscribe function. */
export function onSmsDelivery(cb: (e: SmsDeliveryEvent) => void): () => void {
  if (!smsSenderSupported) return () => {};
  let handle: PluginListenerHandle | undefined;
  let removed = false;
  smsSender
    .addListener('smsDelivery', cb)
    .then((h) => {
      if (removed) void h.remove();
      else handle = h;
    })
    .catch(() => {});
  return () => {
    removed = true;
    if (handle) void handle.remove();
  };
}

/** Subscribe to triple-volume SOS events. Returns an unsubscribe function. */
export function onVolumeSos(cb: (event: { timestamp: number }) => void): () => void {
  if (!smsSenderSupported) return () => {};
  let handle: PluginListenerHandle | undefined;
  let removed = false;
  smsSender.addListener('volumeSos', cb)
    .then((h) => { if (removed) void h.remove(); else handle = h; })
    .catch(() => {});
  return () => { removed = true; if (handle) void handle.remove(); };
}
