import { smsConfig } from '../config';
import { logger } from '../utils/logger';
import type { SendSmsResult } from './sms';

/** Stored in AlertDelivery.providerMessageId so gateway messages can be told apart and polled. */
export const GATEWAY_ID_PREFIX = 'gw:';

export function isGatewayConfigured(): boolean {
  const g = smsConfig.gateway;
  return Boolean(g.url && g.username && g.password);
}

function baseUrl(): string {
  return smsConfig.gateway.url.replace(/\/+$/, '');
}

async function gatewayFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const { username, password, timeoutMs } = smsConfig.gateway;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(`${baseUrl()}${path}`, {
      ...init,
      signal: controller.signal,
      headers: {
        Authorization: 'Basic ' + Buffer.from(`${username}:${password}`).toString('base64'),
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...(init.headers as Record<string, string> | undefined),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Queues one SMS on the phone. Success means "accepted by the gateway", not "delivered". */
export async function sendViaGateway(to: string, message: string): Promise<SendSmsResult> {
  if (!isGatewayConfigured()) {
    return {
      success: false,
      status: 'FAILED',
      error: 'SMS gateway not configured (set SMS_GATEWAY_URL, SMS_GATEWAY_USERNAME, SMS_GATEWAY_PASSWORD)',
    };
  }

  const body = JSON.stringify({
    textMessage: { text: message },
    phoneNumbers: [to],
    withDeliveryReport: true, // needed for the "Delivered" state
  });

  try {
    // Different app/API versions expose /message or /messages; fall back on 404/405.
    let res = await gatewayFetch('/message', { method: 'POST', body });
    if (res.status === 404 || res.status === 405) {
      res = await gatewayFetch('/messages', { method: 'POST', body });
    }

    if (res.status === 401 || res.status === 403) {
      return { success: false, status: 'FAILED', error: 'SMS gateway rejected the credentials' };
    }
    if (!res.ok) {
      return { success: false, status: 'FAILED', error: `SMS gateway returned HTTP ${res.status}` };
    }

    const data: any = await res.json().catch(() => ({}));
    if (!data?.id) {
      return { success: false, status: 'FAILED', error: 'SMS gateway response had no message id', rawResponse: data };
    }
    logger.info('SMS queued on gateway phone', { gatewayMessageId: data.id, state: data.state });
    return { success: true, messageId: `${GATEWAY_ID_PREFIX}${data.id}`, status: 'SENT', rawResponse: data };
  } catch (err: any) {
    const reason = err?.name === 'AbortError' ? 'timed out' : err?.message || 'network error';
    logger.error('Cannot reach SMS gateway phone', { error: reason });
    return { success: false, status: 'FAILED', error: `Cannot reach SMS gateway (${reason})` };
  }
}

export interface GatewayMessageInfo {
  state: string; // Pending | Processed | Sent | Delivered | Failed | Cancelled | Unknown
  reason?: string;
}

/** Returns null when the gateway can't be reached (caller should just try again later). */
export async function getGatewayMessage(gatewayId: string): Promise<GatewayMessageInfo | null> {
  if (!isGatewayConfigured()) return null;
  try {
    let res = await gatewayFetch(`/messages/${encodeURIComponent(gatewayId)}`);
    if (res.status === 404) res = await gatewayFetch(`/message/${encodeURIComponent(gatewayId)}`);
    if (res.status === 404) return { state: 'Unknown' };
    if (!res.ok) return null;
    const data: any = await res.json();
    const failedRecipient = Array.isArray(data?.recipients) ? data.recipients.find((r: any) => r?.error) : undefined;
    return { state: String(data?.state || 'Unknown'), reason: data?.reason || failedRecipient?.error };
  } catch {
    return null;
  }
}
