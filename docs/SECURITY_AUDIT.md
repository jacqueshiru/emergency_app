# SEAS Security & Data Audit

Date: 2026-11-14 · Scope: backend source, frontend token handling, dependencies, secrets/config.
Method: static code review + `npm audit` + git-history check. NOT a penetration test. Hosting/infrastructure not reviewed (none exists yet).

## Verified good
- No raw SQL anywhere (Prisma only) -> no SQL injection surface found.
- Ownership enforced inside queries for alerts; refresh tokens stored hashed; OTP stored hashed with atomic attempt cap.
- Webhook secret compared in constant time, fail-closed when unset.
- Logger redacts phones, OTPs, tokens, secrets, coordinates (confirmed in real logs).
- Frontend has no XSS sinks (no dangerouslySetInnerHTML / innerHTML / eval).
- `.env` and `*.db` were never committed to git history; current secrets are strong (48+ chars).
- AT_API_KEY is empty, so no SMS-provider key exists to leak.

## Findings

| # | Severity | Finding | Status |
|---|----------|---------|--------|
| 1 | Critical* | OTP returned in the API response / logged whenever NODE_ENV was unset (defaults to "development") and AT_API_KEY empty. Becomes true for SMS_PROVIDER=gateway too. A deployment missing NODE_ENV would let anyone log in as any phone number. | FIXED: `devOtpAllowed()` needs explicit ALLOW_DEV_OTP=true, never with a real SMS provider, never in production |
| 2 | High | Built-in default JWT secrets used silently if env vars are missing; no production guard. | FIXED: server refuses to start in production with weak/default secrets, wildcard CORS, no SMS provider or no WEBHOOK_SECRET |
| 3 | High | SMS abuse: unlimited contacts per user, no rate limit on SOS creation, any phone number can be added as a "contact" without consent, user-controlled name placed in SMS (phishing links). | PARTLY FIXED: 10-contact cap, 20 alerts/hour/user, links/control chars stripped from names. OPEN: contact consent (opt-in) |
| 4 | High | CORS reflected any origin; Socket.IO allowed "*"; CORS_ORIGIN setting existed but was ignored. | FIXED |
| 5 | Medium | No rate limit on /auth/otp/verify, /auth/refresh or globally. | FIXED (20 / 30 / 300 per window per IP) |
| 6 | Medium | Per-phone OTP cooldown lives in process memory (resets on restart, not shared across instances). | OPEN: move to DB/Redis |
| 7 | Medium | Refresh tokens: 30-day life, never rotated, no reuse detection, expired sessions never purged. | OPEN |
| 8 | Medium | Tokens in localStorage (readable by any XSS). | OPEN: strict CSP on frontend host; consider httpOnly cookie for refresh token |
| 9 | Medium | Admin is single-factor (OTP to one phone). SIM swap on an admin number exposes every user's location/phone. Audit log records only "alerts viewed", not which records. | OPEN: admin MFA or IP allowlist; per-record audit |
| 10 | Medium | Personal data stored in plaintext (phones, contacts, precise locations), kept forever, no account deletion / data export (Kenya Data Protection Act 2019 data-subject rights). | OPEN: Postgres with encryption at rest + encrypted backups, retention job, delete/export endpoints, privacy policy |
| 11 | Medium | Phone-gateway credentials travel as HTTP Basic over plain HTTP on the LAN; anyone with them can send SMS from your SIM. | OPEN: trusted network/VPN only, strong password, never expose the phone's port to the internet |
| 12 | Medium | Runtime dependency advisories: body-parser (high, DoS), qs (moderate), react-router-dom (moderate, open redirect). Dev-only: vite/vitest (critical/high, dev server only). | OPEN: `npm audit fix` for body-parser/qs; bump react-router-dom; upgrade vite/vitest separately |
| 13 | Low | `[DEV ONLY]` log line printed full phone + OTP (string messages are not redacted). | FIXED (masked and gated) |
| 14 | Low | JWT algorithm not pinned; socket and API accepted any HMAC alg. | FIXED (HS256 only) |
| 15 | Low | Contact update/delete verified ownership by a separate read, then wrote by id. | FIXED (ownership in the write) |
| 16 | Low | Unbounded admin queries; large JSON bodies; X-Powered-By header. | FIXED (page size cap, 20kb bodies, header off) |
| 17 | Low | Role in a token is trusted for its 15-minute life; sockets stay authorised after token expiry. | OPEN |
| 18 | Low | OTP hash = HMAC(JWT secret); 6 digits are brute-forceable offline if DB + secret both leak (OTPs live 5 min). Rotating JWT_SECRET invalidates all sessions. | ACCEPTED / documented |
| 19 | Info | Webhook secret travels in the URL query, so proxy access logs may record it. (Not used by the phone gateway, which is polled.) | Documented |

*Critical only in a misconfigured deployment; harmless on a correctly configured server.

## Needed before real users
1. Postgres + encryption at rest + encrypted, tested backups.
2. Contact opt-in (confirmation SMS) and a way for contacts to stop receiving alerts.
3. Delete-account / export-data endpoints, retention policy, privacy policy.
4. Admin MFA or IP allowlist, per-record audit logging.
5. Refresh-token rotation with reuse detection; strict CSP on the frontend host.
6. Fix runtime dependency advisories; add `npm audit` to CI.
7. Independent penetration test once hosted.

## Update: SOS texts sent from the user's phone
- The server no longer pays for or sends these SMS, which removes the server-side SMS-cost/abuse vector for them
  (finding 3). A user can only text numbers from their own SIM and airtime.
- New data on devices: contact names/numbers are cached on the phone in Keystore-backed storage and cleared on logout.
- New server surface: `POST /alerts` with `sentByDevice` (device-reported delivery results are recorded as
  reported; contacts missing from the report are marked FAILED) and `POST /alerts/:id/device-reports`
  (ownership enforced in the query; only `device-sms` deliveries can be changed; DELIVERED/FAILED only).
- The server cannot verify that a phone really sent a text. Device-reported statuses are the user's own claims about
  their own alert; treat them as informational, not as proof of delivery.
- `SEND_SMS` is a sensitive permission: only request it in builds you distribute deliberately.
