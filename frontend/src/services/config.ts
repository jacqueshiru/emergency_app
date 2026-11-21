/**
 * Where the backend lives.
 *  - Browser dev/prod behind the same host: no URL -> relative URLs (/api, /socket.io).
 *  - Android app: the URL baked in at build time (VITE_API_URL in frontend/.env.android) is only the DEFAULT.
 *    It can be overridden at runtime from the login screen ("Server address"), which is what you need with a
 *    Cloudflare quick tunnel: its trycloudflare.com address changes every time cloudflared restarts.
 */
const KEY = 'seas_server_url';
const BUILD_TIME_ORIGIN = ((import.meta.env.VITE_API_URL as string | undefined) || '').replace(/\/+$/, '');

/** Normalises user input to an origin like https://abc.trycloudflare.com ; null if it is not a valid http(s) URL. */
export function normalizeServerUrl(input: string): string | null {
  let raw = input.trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (!raw) return null;
  if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
  try {
    const u = new URL(raw);
    return u.origin;
  } catch {
    return null;
  }
}

export function getServerOrigin(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved) return saved;
  } catch {
    // storage unavailable: fall back to the build-time value
  }
  return BUILD_TIME_ORIGIN;
}

/** Saves (or, with an empty string, clears) the runtime override. Returns false for an invalid URL. */
export function setServerOrigin(input: string): boolean {
  try {
    if (!input.trim()) {
      localStorage.removeItem(KEY);
      return true;
    }
    const origin = normalizeServerUrl(input);
    if (!origin) return false;
    localStorage.setItem(KEY, origin);
    return true;
  } catch {
    return false;
  }
}

export const getApiBase = (): string => `${getServerOrigin()}/api`;

export interface ConnectionCheck {
  ok: boolean;
  message: string;
}

/** Calls GET <server>/api/health and explains the result in plain words. */
export async function checkServer(input?: string): Promise<ConnectionCheck> {
  const origin = input !== undefined ? normalizeServerUrl(input) : getServerOrigin();
  if (input !== undefined && !origin) return { ok: false, message: 'That is not a valid address.' };
  const base = `${origin ?? ''}/api`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(`${base}/health`, { signal: controller.signal, headers: { Accept: 'application/json' } });
    if (!res.ok) {
      return { ok: false, message: `The server answered HTTP ${res.status}. If you use a tunnel, check it points at the backend port (5000).` };
    }
    const data = await res.json().catch(() => null);
    if (data?.status !== 'ok') return { ok: false, message: 'That address is reachable but it is not the SEAS backend.' };
    return { ok: true, message: 'Connected to the SEAS server.' };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { ok: false, message: 'The server did not answer within 10 seconds. Is the tunnel still running?' };
    return {
      ok: false,
      message:
        'Could not reach the server. Check that the backend and the tunnel are running, the address is current ' +
        '(quick-tunnel addresses change on every restart), and CORS allows https://localhost.',
    };
  } finally {
    clearTimeout(timer);
  }
}
