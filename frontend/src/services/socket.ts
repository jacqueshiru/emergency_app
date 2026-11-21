import { io, Socket } from 'socket.io-client';
import { getServerOrigin } from './config';

/** Opens the realtime connection to the right backend (same-origin on web, absolute URL in the app). */
export function connectSocket(token: string): Socket {
  const opts = { auth: { token } };
  const origin = getServerOrigin();
  return origin ? io(origin, opts) : io(opts);
}
