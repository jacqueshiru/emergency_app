import { config, smsConfig } from '../config';
import { sendViaGateway } from './smsGateway';
import { logger } from '../utils/logger';

export interface SendSmsResult {
  success: boolean;
  messageId?: string;
  status: 'SENT' | 'FAILED';
  rawResponse?: any;
  error?: string;
}

export class SmsService {
  private username: string;
  private apiKey: string;
  private senderId: string;
  private isSandbox: boolean;

  constructor() {
    this.username = config.africasTalking.username || 'sandbox';
    this.apiKey = config.africasTalking.apiKey;
    this.senderId = config.africasTalking.senderId;
    this.isSandbox = this.username.toLowerCase() === 'sandbox';
  }

  /**
   * Sends an SMS via Africa's Talking
   * Reflects evidence: receiving gateway response only sets SENT, never DELIVERED.
   */
  async sendSms(to: string, message: string): Promise<SendSmsResult> {
    if (smsConfig.provider === 'gateway') {
      return sendViaGateway(to, message);
    }

    if (smsConfig.provider !== 'mock' && !this.apiKey) {
      // Never pretend: a "sent" status with no provider would hide a real failure in an emergency app.
      logger.error('No SMS provider configured on the server; message NOT sent', { to });
      return { success: false, status: 'FAILED', error: 'No SMS provider is configured on the server' };
    }

    if (smsConfig.provider === 'mock') {
      logger.warn('SMS_PROVIDER=mock: simulating SMS dispatch (nothing is really sent)', { to });
      return {
        success: true,
        messageId: `mock-msg-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
        status: 'SENT',
        rawResponse: { status: 'Success', mock: true },
      };
    }

    const host = this.isSandbox
      ? 'api.sandbox.africastalking.com'
      : 'api.africastalking.com';
    const url = `https://${host}/version1/messaging`;

    const body = new URLSearchParams();
    body.append('username', this.username);
    body.append('to', to);
    body.append('message', message);
    if (this.senderId && !this.isSandbox) {
      body.append('from', this.senderId);
    }

    // Without a timeout a hung connection outlives the worker's claim TTL and the same SMS gets sent twice.
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'apiKey': this.apiKey,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Accept': 'application/json',
        },
        body: body.toString(),
        signal: controller.signal,
      });

      const data: any = await response.json();
      logger.info('Africa\'s Talking dispatch response', { status: response.status, data });

      // Parse Africa's Talking SMS response structure:
      // { SMSMessageData: { Recipients: [ { number: '+254...', status: 'Success', messageId: 'ATXid...', cost: '...' } ] } }
      const recipients = data?.SMSMessageData?.Recipients;
      if (recipients && recipients.length > 0) {
        const recipient = recipients[0];
        const statusText = recipient.status?.toLowerCase();
        if (statusText === 'success') {
          return {
            success: true,
            messageId: recipient.messageId,
            status: 'SENT', // Gateway accepted; delivery pending provider webhook
            rawResponse: data,
          };
        } else {
          return {
            success: false,
            messageId: recipient.messageId,
            status: 'FAILED',
            error: recipient.status || 'Failed at gateway',
            rawResponse: data,
          };
        }
      }

      return {
        success: false,
        status: 'FAILED',
        error: data?.SMSMessageData?.Message || 'No recipient data returned',
        rawResponse: data,
      };
    } catch (err: any) {
      const reason = err?.name === 'AbortError' ? 'timed out' : err.message;
      logger.error('Error contacting Africa\'s Talking SMS gateway', { error: reason });
      return {
        success: false,
        status: 'FAILED',
        error: reason || 'SMS Gateway Network Error',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

export const smsService = new SmsService();
