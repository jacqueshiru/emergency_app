# SEAS real-world test sheet (phone SMS)

Goal: prove the SOS path with real people and real conditions: your real SIM texting real contacts on
real carriers, real GPS, real mobile network, real signal loss.

## What is real, what is not (yet)
| Real | Not real yet |
|---|---|
| Your SIM and number, the SMS the contacts receive | Login code: read from the backend console (ALLOW_DEV_OTP) unless you set up a gateway phone |
| Real contacts on Safaricom / Airtel / Telkom | Backend runs on your PC behind a temporary public tunnel |
| Real GPS, real mobile data, real signal loss | Local SQLite database, not Postgres |

## Rules
1. Tell every contact first. The app is in TEST MODE: texts say "TEST ONLY - NOT A REAL EMERGENCY".
2. Never use police/ambulance numbers as contacts.
3. Use 3-4 contacts on different networks and ask each to note the time the text arrived.
4. Expect about 15-25 SMS in total (about KES 20-30 of your bundle).
5. Close the tunnel window when you stop; it exposes your PC's backend while open.

## Setup (once)
backend\.env:      ALLOW_DEV_OTP="true"   CORS_ORIGIN="http://localhost:5173,https://localhost"   TRUST_PROXY="1"
                   (no SMS_PROVIDER line: the server must NOT send SMS in this test)
frontend\.env.android:  VITE_API_URL=<tunnel address>   VITE_TEST_MODE=true
Optional clean start (WIPES dev data): stop backend, then  cd backend ; npx prisma db push --force-reset
Then: npm run dev:backend | cloudflared tunnel --url http://localhost:5000 | npm run android:sync | npm run android:open | Run on phone.

## Scenarios (fill the table)
| # | Scenario | Expected |
|---|---|---|
| R1 | Real login with your own number, add 3-4 real contacts | Logged in, contacts listed, "SMS from this phone: ON" |
| R2 | OUTDOORS, clear sky, wait 30-60 s, trigger | "GPS Ready (+-X m)"; SMS has a map link; the pin is within ~50 m of where you stood |
| R3 | Wi-Fi OFF, mobile data ON, trigger | Every contact gets exactly ONE text; record seconds until arrival per carrier |
| R4 | INDOORS / poor GPS, trigger | "Approximate location" or "Location unavailable" shown honestly; SMS still sent |
| R5 | Mobile data OFF but signal ON, trigger | Texts still arrive; blue "record will upload" banner; after turning data on it syncs |
| R6 | NO signal (airplane mode or deep indoors), trigger | Honest failure message, NO "sent" status, nothing falsely delivered; alert queued |
| R7 | Contact's phone switched off | Status stays "Sent from phone" (or failed); text arrives when their phone is back on |
| R8 | Duplicate check | Each contact got exactly one text for one SOS (not two) |
| R9 | Hold the button but release early | Nothing is sent |
| R10 | Kill the app, reopen, offline queued alert | Alert still shown; uploads after reconnect |
| R11 | Phone reboot, open app | Still logged in; contacts still work offline |
| R12 | Deny the SMS permission in Android settings, reopen | Amber "Allow SMS" notice; SOS falls back honestly (server has no SMS provider, so it must report FAILED, not sent) |
| R13 | Resolve a synced alert; trigger a new one | Works; one open alert at a time |

## Results (copy and fill)
| # | Pass/Fail | Seconds until text arrived | Contact network | What actually happened / notes |
|---|---|---|---|---|
| R1 | | | | |
| R2 | | | | |
