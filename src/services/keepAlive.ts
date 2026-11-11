import { env } from '../config/env';

const INTERVAL_MS = 10 * 60 * 1000; // every 10 minutes

/**
 * Hosts like Render's free tier put a service to sleep after ~15 minutes without inbound traffic,
 * which also drops WebSocket connections. Pinging our own public URL counts as inbound traffic.
 * Only runs in production, and only when the public URL is known.
 */
export function startKeepAlive(): () => void {
  const base = (process.env.RENDER_EXTERNAL_URL || env.KEEP_ALIVE_URL || env.publicApiUrl).replace(/\/$/, '');
  if (!env.isProd || !env.KEEP_ALIVE || /localhost|127\.0\.0\.1/.test(base)) return () => undefined;

  const ping = async () => {
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.timeout(15_000) });
      // eslint-disable-next-line no-console
      console.log(`[keep-alive] ${base}/health → ${res.status}`);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn(`[keep-alive] ping failed: ${(err as Error).message}`);
    }
  };

  const timer = setInterval(() => void ping(), INTERVAL_MS);
  // eslint-disable-next-line no-console
  console.log(`[keep-alive] pinging ${base}/health every ${INTERVAL_MS / 60000} minutes`);
  return () => clearInterval(timer);
}
