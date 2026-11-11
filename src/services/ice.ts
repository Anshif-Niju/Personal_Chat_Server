import crypto from 'crypto';
import { env } from '../config/env';

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * STUN + TURN configuration for RTCPeerConnection.
 * - TURN_SECRET set → coturn REST API style time-limited credentials (username = "<expiry>:<userId>").
 * - otherwise TURN_USERNAME/TURN_CREDENTIAL static credentials (managed TURN providers).
 */
export function getIceServers(userId: string): IceServer[] {
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
