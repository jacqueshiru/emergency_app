import type { DeviceDeliveryReportDTO } from '@seas/shared';
import { smsSender, smsSenderSupported } from './smsSender';
import type { CachedContact } from './contactsCache';

/** Texts the emergency contacts from the user's own SIM. Works with no internet, only mobile signal. */
export type DeviceSmsState = 'unsupported' | 'checking' | 'ready' | 'denied' | 'unavailable';

/** Checks for a SIM and the SEND_SMS permission, asking for it if needed. Do this BEFORE an emergency. */
export async function initDeviceSms(): Promise<DeviceSmsState> {
  if (!smsSenderSupported) return 'unsupported';
  try {
    const { available } = await smsSender.isAvailable();
    if (!available) return 'unavailable';
    let perm = await smsSender.checkPermissions();
    if (perm.sms !== 'granted') perm = await smsSender.requestPermissions({ permissions: ['sms'] });
    return perm.sms === 'granted' ? 'ready' : 'denied';
  } catch {
    return 'unavailable';
  }
}

/** Display names go in an SMS: strip control characters and links, keep it short. */
function cleanName(input: string, max = 30): string {
  return input
    .replace(/[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max)
    .trim();
}

/** Build-time switch (frontend/.env.android: VITE_TEST_MODE=true) so tests never alarm real contacts. */
export const TEST_MODE = import.meta.env.VITE_TEST_MODE === 'true';

export function buildSosMessage(opts: { name: string; latitude: number | null; longitude: number | null }): string {
  const who = cleanName(opts.name) || 'Someone';
  const where =
    opts.latitude != null && opts.longitude != null
      ? `Location: https://maps.google.com/?q=${opts.latitude.toFixed(5)},${opts.longitude.toFixed(5)}`
      : 'Location unavailable.';
  if (TEST_MODE) {
    return `TEST ONLY - NOT A REAL EMERGENCY. ${who} is testing the SEAS SOS app. ${where}`;
  }
  return `EMERGENCY! ${who} pressed SOS and needs help. ${where} - sent by SEAS app`;
}

export const DEVICE_ID_SEPARATOR = '|';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sends the SOS text to every contact in parallel; each contact gets one retry after 3 s if the
 * phone reported a failure (e.g. momentary loss of signal). Message ids are `<alertKey>|<contactId>`
 * so later delivery reports can be matched back to the contact.
 */
export async function sendSosFromDevice(
  contacts: CachedContact[],
  message: string,
  alertKey: string,
  onResult?: (r: DeviceDeliveryReportDTO) => void
): Promise<DeviceDeliveryReportDTO[]> {
  const sendOne = async (c: CachedContact): Promise<DeviceDeliveryReportDTO> => {
    const base = `${alertKey}${DEVICE_ID_SEPARATOR}${c.id}`;
    const attempt = async (id: string) => {
      try {
        return await smsSender.send({ id, to: c.phoneNumber, message });
      } catch (e: any) {
        return { id, status: 'failed' as const, error: e?.message || 'Send error', code: e?.code as string | undefined };
      }
    };

    let res: { status: 'sent' | 'failed' | 'unknown'; error?: string; code?: string } = await attempt(base);
    if (res.status === 'failed' && res.code !== 'PERMISSION_DENIED') {
      await sleep(3000);
      res = await attempt(`${base}${DEVICE_ID_SEPARATOR}r`);
    }
    const report: DeviceDeliveryReportDTO =
      res.status === 'failed'
        ? { contactId: c.id, status: 'FAILED', error: res.error || 'Send failed' }
        : { contactId: c.id, status: 'SENT', error: res.status === 'unknown' ? 'Not confirmed by the phone' : null };
    onResult?.(report);
    return report;
  };

  return Promise.all(contacts.map(sendOne));
}
