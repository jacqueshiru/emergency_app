# SEAS Android app (Capacitor)

The Android app is your existing React app wrapped in a native shell. App id: `ke.ac.zetech.seas`
(set in `frontend/capacitor.config.json`; changing it later makes it a different app on Play).

## One-time setup (Windows)
1. Node 22+ (you have 24). Install **Android Studio** (current version; it bundles the JDK and SDK).
   If it offers to update Gradle / the Android Gradle plugin, accept.
2. On your Android phone: Settings > About phone > tap *Build number* 7 times, then
   Developer options > turn on **USB debugging**.
3. From the project root: `npm ci`

## The backend must be reachable over HTTPS
The app cannot use `localhost` or a plain `http://` address. Use your hosted backend, or an https tunnel
for testing. In `backend\.env` allow the app's origin (the WebView calls from `https://localhost`):
```
CORS_ORIGIN="https://your-web-origin,https://localhost"
```
(In production the backend refuses to start if CORS is `*`, so list real origins.)

## Using a Cloudflare quick tunnel (trycloudflare.com)
`cloudflared tunnel --url http://localhost:5000` prints a new `https://<random>.trycloudflare.com` address **every time it
starts**, so a URL baked into the APK goes stale. You do not need to rebuild:
1. Start the backend, then the tunnel. Copy the printed address.
2. In the app: Login screen > **Server settings** > paste the address > **Test & save**. It calls `/api/health` and tells you
   what is wrong if it fails. (It also opens automatically when a code request cannot reach the server.)
3. Backend `.env`: set `TRUST_PROXY=1` (so rate limits see each phone's real IP, not the tunnel's). The Android WebView origins
   (`https://localhost`, `capacitor://localhost`) are now allowed automatically; set `ALLOW_NATIVE_APP_ORIGINS=false` to opt out.
For an address that never changes, use a named Cloudflare tunnel with your own domain.

## Build and run on your phone
1. Copy `frontend\.env.android.example` to `frontend\.env.android` and set `VITE_API_URL` to your https backend.
2. `npm run android:sync`   (builds the web app, copies it into the Android project)
3. `npm run android:open`   (opens Android Studio). Wait for "Gradle sync" to finish.
4. Plug in the phone, choose it in the device list, press the green Run button.
   Whenever you change web code, run `npm run android:sync` again, then Run.

`npm --workspace=frontend run cap:doctor` checks your setup if something looks wrong.

## Test checklist (real phone)
- Login with an SMS code arrives and works; closing and reopening the app keeps you signed in.
- Location permission prompt appears; SOS shows "GPS Ready" or "Approximate location".
- Hold-to-confirm vibrates; the alert is created; contacts receive the SMS.
- Airplane mode > trigger SOS > it queues > turn airplane mode off > it sends by itself.
- Top of the screen is not hidden under the status bar (if it is, adjust the `body` padding in `frontend\src\index.css`).

## Make an APK to send to people
1. Android Studio > Build > **Generate Signed App Bundle / APK** > choose **APK**.
2. Create a keystore (Create new...). **Back up the keystore file and both passwords somewhere safe and
   never commit them**: if you lose it you can never publish an update to the same app.
3. Choose the *release* build type. The APK ends up in `frontend\android\app\release\`.
4. Before each new version raise `versionCode` (and `versionName`) in `frontend\android\app\build.gradle`.

## Sending it to the users you choose
- **Direct APK:** share the file (link or messaging app). Each person must allow "Install unknown apps"
  for the app they opened it from. Google is rolling out *developer verification*: enforcement began
  on 30 Sep 2026 in Brazil, Indonesia, Singapore and Thailand and is planned to go global in 2027;
  unverified apps then need an advanced, delayed install flow. Kenya was not in the first group, but plan
  for it by registering with Google's Android developer verification before 2027.
- **Google Play internal / closed testing:** upload the release `.aab` (Build > Generate Signed Bundle) and
  invite chosen people by email; they install from Play. Needs a Play developer account (one-time fee).
  Public release on a new personal account additionally needs a closed test with 12 testers for 14 days.

## Known limits
- The app must be open to trigger an SOS; there is no lock-screen or power-button trigger yet (needs native code).
- The offline queue uses the WebView's storage. Treat it as best-effort if the phone is nearly out of space.
- Icon and splash screen are the Capacitor defaults; replace them with `@capacitor/assets` before wider sharing.
- For quick tests against a plain-http LAN server you would have to enable mixed content/cleartext in the
  Capacitor config. Do that only on a throwaway build, never in a build you send to others.

## SOS texts sent from the user's own phone (no server, no internet needed)
The Android app texts the emergency contacts itself, from the phone's own SIM, using the SMS
permission. It works with only mobile signal. Contacts see the user's real number.

How it works
1. On the SOS screen the app asks for the SMS permission up front (never mid-emergency) and keeps an
   on-phone, Keystore-protected copy of the contacts (refreshed whenever the app is online).
2. Hold-to-confirm sends one text per contact, in parallel, with one automatic retry after 3 seconds.
   Each contact shows live status: sending, sent from phone, delivered (carrier report) or failed.
3. If the phone could not send any text (no signal, airplane mode) the app falls back to the server's
   SMS path when online, or queues the alert like before.
4. The alert is then recorded on the server (`sentByDevice: true`). The server does NOT send SMS for
   these alerts. If the phone is offline the record is queued and uploads later, and is never treated as "stale".

Things to know
- **Cost moves to each user:** the texts use that person's own airtime or SMS bundle (about one SMS per contact).
- **"Delivered" means the carrier sent a delivery report.** Android only passes that report to the app; it may
  never arrive (phone off, network without reports), so a contact can stay at "Sent from phone".
- **Dual-SIM phones** use the SIM chosen as the default for SMS in Android settings.
- **Google Play restricts the SMS permission** (as I understand the policy it is reserved for default SMS/phone
  apps, with limited exceptions), so an app like this will likely be rejected from the Play Store. It is fine for
  APKs you send directly to chosen users. Check Play's "SMS and Call Log permissions" policy before planning a Play release.
- **Login still needs the server to send an SMS** (the one-time code). Decide how login works in production:
  keep a small SMS gateway/provider just for login codes, or change the login method.
- Web (browser) users cannot text from their device; they keep using the server's SMS path.
- The native plugin is `frontend/android/app/src/main/java/ke/ac/zetech/seas/SmsSenderPlugin.java`.

Test on a real phone with a SIM
- Allow the SMS permission when asked; the SOS screen shows "SMS from this phone: ON".
- Turn on airplane mode, then re-enable only mobile signal (no Wi-Fi/data) and trigger SOS: contacts should still get texts.
- Trigger with no signal at all: it falls back, queues, and sends when you are back online.
- Use a contact number you control for tests, and tell contacts first.
