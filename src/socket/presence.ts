import { User } from '../models/User';
import { getSettings } from '../models/UserSettings';
import { getFriendIds } from '../services/relationships';
import { emitToUser, isUserOnline } from '../services/realtime';

/** Sends the user's current presence to their friends, honouring privacy settings. */
export async function broadcastPresence(userId: string) {
  const [user, settings, friendIds] = await Promise.all([
    User.findById(userId).select('isOnline lastSeen').lean(),
    getSettings(userId),
    getFriendIds(userId),
  ]);
  if (!user || friendIds.length === 0) return;
  // Recipients are all friends, so "friends" and "everyone" are both visible.
  emitToUser(friendIds, 'presence:update', {
    userId,
    isOnline: settings.privacy.onlineStatus === 'nobody' ? null : user.isOnline,
    lastSeen: settings.privacy.lastSeen === 'nobody' ? null : user.lastSeen,
  });
}

export async function markOnline(userId: string) {
  const res = await User.updateOne({ _id: userId, isOnline: false }, { isOnline: true });
  if (res.modifiedCount > 0) await broadcastPresence(userId);
}

/** Called after a socket disconnects; only goes offline when no device remains connected. */
export async function markOfflineIfLast(userId: string) {
  if (await isUserOnline(userId)) return;
  await User.updateOne({ _id: userId }, { isOnline: false, lastSeen: new Date() });
  await broadcastPresence(userId);
}
