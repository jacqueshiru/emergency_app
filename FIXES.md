# Review fixes (correctness first)

## Backend
1. **Cancelled alerts kept texting contacts.** The delivery worker never looked at the alert's resolution state, so a
   false alarm cancelled within the 5-minute window still had its queued/retrying SMS sent. The worker now marks those
   deliveries FAILED ("Alert was cancelled before this message was sent") instead of sending, and `PATCH /alerts/:id/cancel`
   fails the still-PENDING ones immediately and returns/emits the refreshed alert.
   (`deliveryWorker.ts`, `alerts.controller.ts`, new test `tests/cancelledAlertWorker.test.ts`)
2. **Africa's Talking request had no timeout.** A hung connection outlived the worker's 60 s claim TTL, so the same SMS was
   claimed and sent again. 15 s abort timeout added. (`sms.ts`)
3. **SOS rate limit counted offline-queue replays and 5xx failures.** With retries, one real emergency could lock the user
   out (20/hour). Now only new alerts (201) and 4xx count. (`middleware/auth.ts`)
4. OTP generator never produced 999999 (exclusive upper bound). (`utils/hash.ts`)
5. `GET /admin/alerts?from=garbage` returned 500 (Prisma throws on Invalid Date); invalid dates are now ignored. (`admin.controller.ts`)
6. Concurrent contact create/update of the same number returned 500; now 409. (`contacts.controller.ts`)
7. `GET /alerts` was unbounded; capped at 100. (`alerts.controller.ts`)
8. SIGTERM handler closed the server but never exited (open websockets keep it alive); now exits, with a 10 s cap, and handles SIGINT. (`server.ts`)

## Frontend
1. **Any non-OK response from `/auth/refresh` logged the user out** (429, 502, 503...) and wiped the on-phone contact copy the
   offline SOS depends on. Only 400/401/403 end the session now. (`services/api.ts`)
2. **SOS hit a 5xx/429 and was dropped** with just an error message. It is now queued durably and retried. (`SosPage.tsx`)
3. **No real retry/backoff**: the queue only retried on reconnect/resume events, which never fire when the phone stayed online
   but the server was down. Added backoff retry (5 s -> 60 s) while an alert is waiting. (`SosPage.tsx`)
4. A stale (>10 min) held alert blocked triggering a *new* SOS. It no longer does. (`SosPage.tsx`)
5. Hold gesture: touchstart + emulated mousedown / key auto-repeat could start two loops and double-trigger; the progress ring
   stayed full after an alert was resolved. Guarded and reset. (`SosPage.tsx`)
6. Coordinates of exactly 0 were treated as "no location" by truthiness checks. (`SosPage.tsx`, `AdminDashboardPage.tsx`)
7. **Service worker served the cached app shell forever** (cache-first on `/index.html`), so new deploys never reached
   installed users. Navigations are now network-first with the cache as the offline fallback; cache bumped to v3. (`public/sw.js`)

## Android
- **"Delivered" was reported for failed deliveries.** Android fires the delivery intent with RESULT_OK for any status report.
  The plugin now reads the TP-Status from the report PDU: 0 = delivered, 0x40+ = failed, in-between = ignored (stays SENT).
  (`SmsSenderPlugin.java`) -- NOT compiled here (no Android SDK); build and test on a real phone.

## Connectivity (Android + Cloudflare quick tunnel)
- Backend now always allows the Android WebView origins in CORS and Socket.IO (`corsOriginOption()`), the usual cause of
  "network error" on the phone.
- Server address is configurable at runtime (Login > Server settings, with a Test & save health check), so a changed
  trycloudflare.com URL needs no rebuild. The network error text now says what to check. See docs/ANDROID.md.

## Not changed (flagged only)
- `devOtpAllowed()` returns true for NODE_ENV=development without ALLOW_DEV_OTP, which contradicts SECURITY_AUDIT #1
  (OTP only reaches logs, not the response, but a server with NODE_ENV unset would log OTPs).
- Cancel window is measured from the client-supplied `triggeredAt`, so a delayed/offline alert may already be past 5 min on arrival.
- Device-sent alerts stay PROCESSING if the phone never reports a final status for a SENT contact.
- Queued offline alerts are not cleared on logout, so a different user logging in on the same device would upload them.
- If only *some* contacts fail from the phone's SIM, the server does not retry those (it only falls back when ALL fail).

Rebuild after pulling this: `npm ci && npm run build && npm run android:sync` (dist/ and android build output were left out of the zip).
