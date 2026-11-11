import { Expo, ExpoPushMessage } from 'expo-server-sdk';
import webpush from 'web-push';
import { env } from '../config/env';
import { UserSession } from '../models/UserSession';
import { getSettings, IUserSettings } from '../models/UserSettings';
import { connectedSessionIds, emitToUser } from './realtime';

export type NotificationType =
  | 'message'
  | 'group_message'
  | 'friend_request'
  | 'friend_accepted'
  | 'incoming_call'
  | 'missed_call'
  | 'group_invite';

export interface AppNotification {
  type: NotificationType;
  title: string;
  body: string;
  data?: Record<string, string | number | boolean | null>;
}

const expo = new Expo(env.EXPO_ACCESS_TOKEN ? { accessToken: env.EXPO_ACCESS_TOKEN } : {});

const webPushEnabled = !!(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
if (webPushEnabled) webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY!, env.VAPID_PRIVATE_KEY!);

export const vapidPublicKey = () => (webPushEnabled ? env.VAPID_PUBLIC_KEY! : null);

function isEnabled(type: NotificationType, s: IUserSettings['notifications']): boolean {
  switch (type) {
    case 'message':
      return s.messages;
    case 'group_message':
    case 'group_invite':
      return s.groups;
    case 'incoming_call':
    case 'missed_call':
      return s.calls;
    case 'friend_request':
    case 'friend_accepted':
      return s.friendRequests;
    default:
      return true;
  }
}

/**
 * Delivers a notification:
 *  - `socket` (default true): emits a `notification` event to every connected device
 *  - push: Expo / Web Push to the user's devices that are NOT currently connected
 */
export async function notify(userId: string, n: AppNotification, opts: { socket?: boolean } = {}) {
  try {
    if (opts.socket !== false) emitToUser(userId, 'notification', { ...n, createdAt: new Date().toISOString() });

    const settings = await getSettings(userId);
    if (!isEnabled(n.type, settings.notifications)) return;

    const isMessage = n.type === 'message' || n.type === 'group_message';
    const body = isMessage && !settings.notifications.showPreview ? 'New message' : n.body;

    const online = await connectedSessionIds(userId);
    const sessions = await UserSession.find({
      userId,
      revokedAt: null,
      expiresAt: { $gt: new Date() },
      $or: [{ expoPushToken: { $ne: null } }, { webPush: { $ne: null } }],
    })
      .select('_id expoPushToken webPush')
      .lean();

    const offline = sessions.filter((s) => !online.has(String(s._id)));
    const isCall = n.type === 'incoming_call';

    // ---- Expo (mobile) ----
    const expoMessages: ExpoPushMessage[] = [];
    const tokenToSession = new Map<string, string>();
    for (const s of offline) {
      if (s.expoPushToken && Expo.isExpoPushToken(s.expoPushToken)) {
        tokenToSession.set(s.expoPushToken, String(s._id));
        expoMessages.push({
          to: s.expoPushToken,
          title: n.title,
          body,
          data: { ...n.data, type: n.type },
          sound: settings.notifications.sound ? 'default' : undefined,
          priority: isCall || isMessage ? 'high' : 'default',
          channelId: isCall ? 'calls' : 'messages',
          ttl: isCall ? 45 : undefined,
        });
      }
    }
    for (const chunk of expo.chunkPushNotifications(expoMessages)) {
      const tickets = await expo.sendPushNotificationsAsync(chunk).catch(() => []);
      tickets.forEach((t, i) => {
        if (t.status === 'error' && t.details?.error === 'DeviceNotRegistered') {
          const sid = tokenToSession.get(String(chunk[i].to));
          if (sid) UserSession.updateOne({ _id: sid }, { expoPushToken: null }).catch(() => undefined);
        }
      });
    }

    // ---- Web Push (browsers) ----
    if (webPushEnabled) {
      await Promise.all(
        offline
          .filter((s) => s.webPush?.endpoint)
          .map((s) =>
            webpush
              .sendNotification(s.webPush as webpush.PushSubscription, JSON.stringify({ title: n.title, body, data: { ...n.data, type: n.type } }), {
                TTL: isCall ? 45 : 3600,
                urgency: isCall ? 'high' : 'normal',
              })
              .catch((err: { statusCode?: number }) => {
                if (err.statusCode === 404 || err.statusCode === 410) {
                  return UserSession.updateOne({ _id: s._id }, { webPush: null });
                }
                return undefined;
              }),
          ),
      );
    }
  } catch (err) {
    if (!env.isTest) {
      // eslint-disable-next-line no-console
      console.error('[notify] failed', err);
    }
  }
}
