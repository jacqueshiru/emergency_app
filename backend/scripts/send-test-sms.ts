/**
 * Sends one test SMS through the configured provider and (for the gateway) watches its status.
 * Usage:  npm --workspace=backend run sms:test -- +2547XXXXXXXX
 * Use a number that is NOT the gateway phone's own SIM.
 */
import { smsConfig } from '../src/config';
import { smsService } from '../src/services/sms';
import { GATEWAY_ID_PREFIX, getGatewayMessage } from '../src/services/smsGateway';

async function main() {
  const to = process.argv[2];
  if (!to || !/^\+\d{9,15}$/.test(to)) {
    console.error('Usage: npm --workspace=backend run sms:test -- +2547XXXXXXXX');
    process.exit(1);
  }
  console.log(`Provider: ${smsConfig.provider}`);
  const result = await smsService.sendSms(to, 'SEAS test message: your SMS gateway is working.');
  if (!result.success) {
    console.error('SEND FAILED:', result.error);
    process.exit(1);
  }
  console.log('Accepted. Message id:', result.messageId);

  if (smsConfig.provider !== 'gateway' || !result.messageId?.startsWith(GATEWAY_ID_PREFIX)) return;
  const id = result.messageId.slice(GATEWAY_ID_PREFIX.length);
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const info = await getGatewayMessage(id);
    console.log(`  status: ${info ? info.state : 'gateway unreachable'}${info?.reason ? ' (' + info.reason + ')' : ''}`);
    if (info && ['Delivered', 'Failed', 'Cancelled'].includes(info.state)) return;
  }
  console.log('Still not confirmed after 60s. Sent can stay "Sent" if Android never reports delivery.');
}

main().catch((e) => { console.error(e); process.exit(1); });
