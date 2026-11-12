import crypto from 'crypto';
import { env } from '../config/env';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

// ---- Cloudflare Realtime TURN: short-lived credentials fetched from their API and cached. ----
const CF_TTL_SECONDS = 24 * 3600;
let cfServers: IceServer[] = [];
let cfRefreshTimer: NodeJS.Timeout | undefined;

async function refreshCloudflare(): Promise<void> {
  const res = await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_KEY_ID}/credentials/generate-ice-servers`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ ttl: CF_TTL_SECONDS }),
  });
  if (!res.ok) throw new Error(`Cloudflare TURN responded ${res.status}`);
  const data = (await res.json()) as { iceServers?: IceServer[] };
  if (!data.iceServers?.length) throw new Error('Cloudflare TURN returned no iceServers');
  cfServers = data.iceServers;
}

/** Call once at startup. No-op unless the Cloudflare env vars are set. Returns a stop function. */
export function startCloudflareTurn(): () => void {
  if (!env.CLOUDFLARE_TURN_KEY_ID || !env.CLOUDFLARE_TURN_API_TOKEN) return () => undefined;
  const run = () =>
    refreshCloudflare().catch((err) => {
      // eslint-disable-next-line no-console
      console.error('[ice] Cloudflare TURN refresh failed:', err instanceof Error ? err.message : err);
    });
  void run();
  cfRefreshTimer = setInterval(run, (CF_TTL_SECONDS / 2) * 1000); // refresh at half-life so credentials never expire
  return () => cfRefreshTimer && clearInterval(cfRefreshTimer);
}

/**
 * STUN + TURN configuration for RTCPeerConnection.
 * - Cloudflare Realtime TURN configured → cached Cloudflare credentials.
 * - TURN_SECRET set → coturn REST API style time-limited credentials (username = "<expiry>:<userId>").
 * - otherwise TURN_USERNAME/TURN_CREDENTIAL static credentials (managed TURN providers).
 */
export function getIceServers(userId: string): IceServer[] {
  if (cfServers.length) return cfServers;
  const servers: IceServer[] = [];
  if (env.stunUrls.length) servers.push({ urls: env.stunUrls });
  if (env.turnUrls.length) {
    if (env.TURN_SECRET) {
      const username = `${Math.floor(Date.now() / 1000) + env.TURN_TTL_SECONDS}:${userId}`;
      const credential = crypto.createHmac('sha1', env.TURN_SECRET).update(username).digest('base64');
      servers.push({ urls: env.turnUrls, username, credential });
    } else if (env.TURN_USERNAME && env.TURN_CREDENTIAL) {
      servers.push({ urls: env.turnUrls, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL });
    }
  }
  return servers;
}
