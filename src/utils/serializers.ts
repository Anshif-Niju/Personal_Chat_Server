/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IUserSettings, Visibility } from '../models/UserSettings';
import { fileUrl } from '../services/storage';

export const PUBLIC_USER_FIELDS = 'username displayName avatar bio isOnline lastSeen createdAt';

export const MESSAGE_POPULATE = [
  { path: 'senderId', select: 'username displayName avatar' },
  {
    path: 'replyTo',
    select: 'senderId content messageType deletedAt attachment',
    populate: { path: 'senderId', select: 'username displayName' },
  },
];

const canSee = (setting: Visibility | undefined, isFriend: boolean) =>
  setting === 'everyone' || ((setting ?? 'friends') === 'friends' && isFriend);

export interface PresenceContext {
  viewerId?: string;
  friendIds?: Set<string>;
  settingsMap?: Map<string, IUserSettings>;
}

export function toPublicUser(user: any, ctx: PresenceContext = {}) {
  if (!user || !user._id) return null;
  const id = String(user._id);
  const isSelf = ctx.viewerId === id;
  const isFriend = ctx.friendIds?.has(id) ?? false;
  const privacy = ctx.settingsMap?.get(id)?.privacy;
  const showOnline = isSelf || canSee(privacy?.onlineStatus, isFriend);
  const showLastSeen = isSelf || canSee(privacy?.lastSeen, isFriend);
  return {
    id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: fileUrl(user.avatar, 'public'),
    bio: user.bio ?? '',
    isOnline: showOnline ? !!user.isOnline : null,
    lastSeen: showLastSeen && user.lastSeen ? new Date(user.lastSeen).toISOString() : null,
    createdAt: user.createdAt ? new Date(user.createdAt).toISOString() : null,
  };
}

/** Full profile for the account owner (includes email). */
export function toMe(user: any) {
  return { ...toPublicUser(user, { viewerId: String(user._id) })!, email: user.email ?? null };
}

function briefSender(s: any) {
  if (!s || !s._id) return null;
  return { id: String(s._id), username: s.username, displayName: s.displayName, avatarUrl: fileUrl(s.avatar, 'public') };
}

function serializeAttachment(a: any) {
  if (!a) return null;
  return {
    url: fileUrl(a, 'private'),
    name: a.name,
    mimeType: a.mimeType,
    size: a.size,
    width: a.width ?? null,
    height: a.height ?? null,
    duration: a.duration ?? null,
  };
}

export function serializeMessage(m: any) {
  if (!m) return null;
  const deleted = !!m.deletedAt;
  const reply = m.replyTo && m.replyTo._id ? m.replyTo : null;
  return {
    id: String(m._id),
    conversationId: String(m.conversationId),
    sender: briefSender(m.senderId),
    senderId: m.senderId ? String(m.senderId._id ?? m.senderId) : null,
    messageType: m.messageType,
    content: deleted ? '' : m.content ?? '',
    attachment: deleted ? null : serializeAttachment(m.attachment),
    replyTo: reply
      ? {
          id: String(reply._id),
          senderName: reply.senderId?.displayName ?? 'Unknown',
          senderId: reply.senderId?._id ? String(reply.senderId._id) : null,
          content: reply.deletedAt ? '' : reply.content ?? '',
          messageType: reply.messageType,
          isDeleted: !!reply.deletedAt,
          attachmentName: reply.deletedAt ? null : reply.attachment?.name ?? null,
        }
      : null,
    forwarded: !!m.forwarded,
    reactions: deleted ? [] : (m.reactions ?? []).map((r: any) => ({ userId: String(r.user), emoji: r.emoji })),
    deliveredTo: (m.deliveredTo ?? []).map((r: any) => ({ userId: String(r.user), at: new Date(r.at).toISOString() })),
    readBy: (m.readBy ?? []).map((r: any) => ({ userId: String(r.user), at: new Date(r.at).toISOString() })),
    editedAt: m.editedAt ? new Date(m.editedAt).toISOString() : null,
    isDeleted: deleted,
    call: m.call
      ? { callId: String(m.call.callId), callType: m.call.callType, status: m.call.status, duration: m.call.duration ?? 0 }
      : null,
    system: m.system
      ? {
          action: m.system.action,
          actorId: m.system.actor ? String(m.system.actor) : null,
          targetIds: (m.system.targets ?? []).map(String),
          value: m.system.value ?? null,
        }
      : null,
    clientId: m.clientId ?? null,
    createdAt: new Date(m.createdAt).toISOString(),
  };
}

export type SerializedMessage = NonNullable<ReturnType<typeof serializeMessage>>;
