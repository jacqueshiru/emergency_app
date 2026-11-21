# Smart Emergency Alert System — Master Build Prompt

## Purpose
This is the complete, self-contained prompt and progress tracker for building this project end-to-end.

## 1. Non-negotiable Constraints
1. **Location-independent SOS**: An SOS must never depend on successful geolocation. If location permission is denied or coordinates can't be obtained, the backend still accepts the alert and records that location is unavailable — it never blocks or silently drops the alert.
2. **Honest SMS status**: SMS status must reflect evidence, not optimism. A gateway accepting a message ≠ the recipient receiving it. Keep pending, sent, delivered, and failed distinct per recipient. A delivery that has reached a terminal state (delivered/failed) must never be overwritten by an older or duplicated provider event.
3. **Idempotent offline retries**: Offline retries must never create duplicate alerts, and must never silently resurrect a stale emergency. Every alert carries a client-generated idempotency key, queued durably (IndexedDB, not memory), retried with backoff. Past 10 minutes, the system stops retrying silently and asks the user to confirm the alert is still relevant.
4. **Server-side contact resolution**: Contacts and recipients are never trusted from the client. The server fetches the authenticated user's saved contacts from the database when an alert is created — it never accepts a recipient list from the request body.
5. **No plaintext credentials**: Credentials are never stored in plaintext. OTP codes and refresh tokens are stored hashed. Admin role can never be self-assigned by a user.
6. **Security before deployment**: Every contact and alert is scoped to its owning user, enforced server-side. Dashboard routes are admin-only, enforced server-side. Rate limits apply to OTP requests. Secrets live in environment variables. Logs redact phone numbers, OTPs, tokens, and coordinates.
7. **Transparent limits**: The system communicates its own limits (not a police/ambulance dispatch integration, does not guarantee SMS delivery, does not provide continuous background tracking).

## 2. Technical Stack
- **Frontend**: React + TypeScript + Vite, Tailwind CSS + shadcn/ui style components, installable PWA (manifest + service worker)
- **Backend**: Node.js + Express + TypeScript + Prisma
- **Database**: PostgreSQL (Neon-ready / PostgreSQL connection string)
- **SMS Gateway**: Africa's Talking (sandbox / configurable)
- **Auth**: Phone number + OTP via SMS (no passwords), JWT + hashed refresh sessions
- **Real-time**: Socket.io for admin dashboard alert/delivery feeds
- **Shared**: Common TypeScript interfaces, DTOs, Enums

## 3. Progress Checklist
- [x] **Phase 0 — Scaffold** (Frontend React+Vite+Tailwind, Backend Express+Prisma, Shared types, /health 200, build scripts)
- [x] **Phase 1 — Auth, Roles, Contacts** (E.164 normalization, hashed OTPs, attempt limits, JWT access + hashed refresh sessions, scoped contact CRUD, duplicate prevention)
- [x] **Phase 2 — SOS Workflow (Persistence & Deduping)** (POST /alerts server-side contact fetching, Alert + AlertDelivery transaction, idempotency key deduplication, locationAvailable handling, zero-contact handling)
- [x] **Phase 3 — SMS Integration & Realtime** (Africa's Talking gateway, delivery status webhook, idempotency & terminal state protection, Socket.io event emission, Alert.status transitions)
- [x] **Phase 4 — Admin Dashboard** (Live feed, Map view with visually distinct location-unavailable marker, filters, user/contact inspection, AuditLog integration, role=ADMIN guard)
- [x] **Phase 5 — Offline Handling, Security Hardening, Polish** (IndexedDB alert queue, 10-minute staleness confirmation, logs redaction, complete security checklist verified with 30 automated tests)
- [ ] **Phase 6 — Capacitor Wrap (Stretch Goal)** (Native shell configuration prepared)
