/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { Conversation, ConversationDoc, privateKeyFor } from '../models/Conversation';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { getSettingsMap } from '../models/UserSettings';
import { ApiError } from '../utils/errors';
import { MESSAGE_POPULATE, PUBLIC_USER_FIELDS, serializeMessage, toPublicUser } from '../utils/serializers';
import { FriendRequest, pairKeyFor } from '../models/FriendRequest';
import { areFriends, getFriendIds, isBlockedEitherWay } from './relationships';
import { emitToConversation, emitToUser, joinConversationRoom, leaveConversationRoom } from './realtime';
import { fileUrl, driverFor } from './storage';
import { notify } from './notifications';

export const MAX_GROUP_MEMBERS = 256;

const oid = (id: string | Types.ObjectId) => new Types.ObjectId(String(id));
const has = (list: Types.ObjectId[], id: string) => list.some((x) => String(x) === String(id));

export async function getConversationForMember(conversationId: string, userId: string): Promise<ConversationDoc> {
  if (!Types.ObjectId.isValid(conversationId)) throw ApiError.notFound('Conversation not found');
  const conv = await Conversation.findOne({ _id: conversationId, participants: userId });
  if (!conv) throw ApiError.notFound('Conversation not found');
  return conv;
}

export const isAdmin = (conv: { admins: Types.ObjectId[] }, userId: string) => has(conv.admins, userId);

/** Earliest timestamp of history visible to a member (after "clear chat", or when they joined a group). */
export function historyFloor(conv: any, userId: string): Date | null {
  const meta = (conv.memberMeta ?? []).find((m: any) => String(m.user) === String(userId));
  if (!meta) return null;
  const candidates: number[] = [];
  if (meta.clearedAt) candidates.push(new Date(meta.clearedAt).getTime());
  if (conv.type === 'group' && meta.joinedAt) candidates.push(new Date(meta.joinedAt).getTime() - 1000);
  return candidates.length ? new Date(Math.max(...candidates)) : null;
}

export async function unreadCount(conv: any, userId: string): Promise<number> {
  const meta = (conv.memberMeta ?? []).find((m: any) => String(m.user) === String(userId));
  const since = meta?.lastReadAt ? new Date(meta.lastReadAt) : new Date(0);
  const floor = historyFloor(conv, userId);
  const after = floor && floor > since ? floor : since;
  return Message.countDocuments({
    conversationId: conv._id,
    createdAt: { $gt: after },
    senderId: { $nin: [oid(userId), null] },
    deletedAt: null,
    deletedFor: { $ne: oid(userId) },
  });
}

interface SerializeCtx {
  friendIds: Set<string>;
  settingsMap: Map<string, any>;
  unread: number;
}

export function serializeConversation(conv: any, viewerId: string, ctx: SerializeCtx) {
  const meta = (conv.memberMeta ?? []).find((m: any) => String(m.user) === viewerId);
  let lastMessage = conv.lastMessage && conv.lastMessage._id ? conv.lastMessage : null;
  if (lastMessage) {
    const hiddenForMe = (lastMessage.deletedFor ?? []).some((x: any) => String(x) === viewerId);
    const floor = historyFloor(conv, viewerId);
    if (hiddenForMe || (floor && new Date(lastMessage.createdAt) <= floor)) lastMessage = null;
  }
  return {
    id: String(conv._id),
    type: conv.type,
    participants: (conv.participants ?? [])
      .filter((p: any) => p && p._id)
      .map((p: any) => toPublicUser(p, { viewerId, friendIds: ctx.friendIds, settingsMap: ctx.settingsMap })),
    admins: (conv.admins ?? []).map(String),
    createdBy: String(conv.createdBy),
    groupName: conv.groupName ?? null,
    groupDescription: conv.groupDescription ?? '',
    groupImageUrl: fileUrl(conv.groupImage, 'public'),
    permissions: conv.permissions,
    pinnedMessageIds: (conv.pinnedMessages ?? []).map(String),
    lastMessage: lastMessage ? serializeMessage(lastMessage) : null,
    lastMessageAt: new Date(conv.lastMessageAt).toISOString(),
    lastReadAt: meta?.lastReadAt ? new Date(meta.lastReadAt).toISOString() : null,
    unreadCount: ctx.unread,
    createdAt: new Date(conv.createdAt).toISOString(),
  };
}

export type SerializedConversation = ReturnType<typeof serializeConversation>;

const CONV_POPULATE = [
  { path: 'participants', select: PUBLIC_USER_FIELDS },
  { path: 'lastMessage', populate: MESSAGE_POPULATE[0] },
];

export async function listConversations(userId: string) {
  const convs = await Conversation.find({ participants: userId }).sort({ lastMessageAt: -1 }).limit(300).populate(CONV_POPULATE).lean();
  const visible = convs;
  const participantIds = [...new Set(visible.flatMap((c: any) => c.participants.filter(Boolean).map((p: any) => String(p._id))))];
  const [friendIds, settingsMap, counts] = await Promise.all([
    getFriendIds(userId),
    getSettingsMap(participantIds),
    Promise.all(visible.map((c) => unreadCount(c, userId))),
  ]);
  const friendSet = new Set(friendIds);
  return visible.map((c, i) => serializeConversation(c, userId, { friendIds: friendSet, settingsMap, unread: counts[i] }));
}

export async function loadSerializedConversation(conversationId: string, viewerId: string) {
  const conv = await Conversation.findOne({ _id: conversationId, participants: viewerId }).populate(CONV_POPULATE).lean();
  if (!conv) return null;
  const ids = (conv.participants as any[]).filter(Boolean).map((p) => String(p._id));
  const [friendIds, settingsMap, unread] = await Promise.all([getFriendIds(viewerId), getSettingsMap(ids), unreadCount(conv, viewerId)]);
  return serializeConversation(conv, viewerId, { friendIds: new Set(friendIds), settingsMap, unread });
}

/** Sends each user their own serialized view of a conversation (presence/unread are per-viewer). */
export async function pushConversation(userIds: string[], conversationId: string, event: 'conversation:new' | 'conversation:updated') {
  await Promise.all(
    userIds.map(async (uid) => {
      const data = await loadSerializedConversation(conversationId, uid);
      if (data) emitToUser(uid, event, data);
    }),
  );
}

export async function createSystemMessage(
  conv: ConversationDoc,
  action: string,
  actor: string | null,
  targets: string[] = [],
  value?: string,
) {
  const msg = await Message.create({
    conversationId: conv._id,
    senderId: null,
    messageType: 'system',
    content: '',
    system: { action, actor: actor ? oid(actor) : undefined, targets: targets.map(oid), value },
  });
  await Conversation.updateOne({ _id: conv._id }, { lastMessage: msg._id, lastMessageAt: msg.createdAt });
  const payload = serializeMessage(msg.toObject());
  emitToConversation(String(conv._id), 'message:new', payload);
  return payload;
}

// ---------- Private ----------

export async function getOrCreatePrivate(userId: string, otherId: string) {
  if (userId === otherId) throw ApiError.badRequest("You can't start a chat with yourself");
  if (!(await User.exists({ _id: otherId }))) throw ApiError.notFound('User not found');
  if (await isBlockedEitherWay(userId, otherId)) throw ApiError.forbidden("You can't message this user");

  const privateKey = privateKeyFor(userId, otherId);
  let conv = await Conversation.findOne({ privateKey });
  if (!conv) {
    if (!(await areFriends(userId, otherId))) throw ApiError.forbidden('You can only start chats with friends');
    const now = new Date();
    try {
      conv = await Conversation.create({
        type: 'private',
        participants: [oid(userId), oid(otherId)],
        admins: [],
        createdBy: oid(userId),
        privateKey,
        lastMessageAt: now,
        memberMeta: [
          { user: oid(userId), joinedAt: now, lastReadAt: now },
          { user: oid(otherId), joinedAt: now, lastReadAt: now },
        ],
      });
    } catch (err: any) {
      if (err?.code !== 11000) throw err;
      conv = await Conversation.findOne({ privateKey });
      if (!conv) throw err;
    }
    joinConversationRoom([userId, otherId], String(conv._id));
  }
  return (await loadSerializedConversation(String(conv._id), userId))!;
}

/**
 * Called when someone registers: makes them friends with every existing user and opens a
 * private chat with each, so everybody appears in everyone's chat list right away.
 */
export async function connectNewUser(newUserId: string) {
  const others = await User.find({ _id: { $ne: newUserId }, approved: { $ne: false } }).select('_id').lean();
  if (others.length === 0) return;
  const now = new Date();
  await FriendRequest.insertMany(
    others.map((o) => ({
      senderId: oid(newUserId),
      receiverId: o._id,
      status: 'accepted' as const,
      pairKey: pairKeyFor(newUserId, String(o._id)),
      respondedAt: now,
    })),
    { ordered: false },
  ).catch(() => undefined);

  const ids = others.map((o) => String(o._id));
  for (let i = 0; i < ids.length; i += 10) {
    await Promise.all(
      ids.slice(i, i + 10).map(async (otherId) => {
        try {
          const conv = await getOrCreatePrivate(newUserId, otherId);
          await pushConversation([otherId], conv.id, 'conversation:new');
        } catch {
          /* skip users we can't connect to (e.g. blocked) */
        }
      }),
    );
  }
}

// ---------- Groups ----------

export async function createGroup(userId: string, input: { name: string; description?: string; memberIds: string[] }) {
  const memberIds = [...new Set(input.memberIds.filter((id) => id !== userId))];
  if (memberIds.length < 1) throw ApiError.badRequest('Add at least one member');
  if (memberIds.length + 1 > MAX_GROUP_MEMBERS) throw ApiError.badRequest(`Groups are limited to ${MAX_GROUP_MEMBERS} members`);
  const friendIds = new Set(await getFriendIds(userId));
  const notFriends = memberIds.filter((id) => !friendIds.has(id));
  if (notFriends.length) throw ApiError.badRequest('You can only add friends to a group');

  const now = new Date();
  const all = [userId, ...memberIds];
  const conv = await Conversation.create({
    type: 'group',
    participants: all.map(oid),
    admins: [oid(userId)],
    createdBy: oid(userId),
    groupName: input.name,
    groupDescription: input.description ?? '',
    lastMessageAt: now,
    memberMeta: all.map((u) => ({ user: oid(u), joinedAt: now, lastReadAt: now })),
  });
  joinConversationRoom(all, String(conv._id));
  await createSystemMessage(conv, 'created', userId, [], input.name);
  await pushConversation(memberIds, String(conv._id), 'conversation:new');

  const creator = await User.findById(userId).select('displayName').lean();
  for (const m of memberIds) {
    void notify(
      m,
      {
        type: 'group_invite',
        title: input.name,
        body: `${creator?.displayName ?? 'Someone'} added you to the group`,
        data: { conversationId: String(conv._id) },
      },
      { socket: false },
    );
  }
  return (await loadSerializedConversation(String(conv._id), userId))!;
}

function assertGroup(conv: ConversationDoc) {
  if (conv.type !== 'group') throw ApiError.badRequest('This action is only available in groups');
}

export async function updateGroupInfo(
  userId: string,
  conversationId: string,
  input: { name?: string; description?: string; permissions?: Partial<ConversationDoc['permissions']> },
) {
  const conv = await getConversationForMember(conversationId, userId);
  assertGroup(conv);
  const admin = isAdmin(conv, userId);
  if ((input.name !== undefined || input.description !== undefined) && conv.permissions.onlyAdminsCanEditInfo && !admin) {
    throw ApiError.forbidden('Only admins can edit group info');
  }
  if (input.permissions && !admin) throw ApiError.forbidden('Only admins can change group permissions');

  if (input.name !== undefined && input.name !== conv.groupName) {
    conv.groupName = input.name;
    await conv.save();
    await createSystemMessage(conv, 'renamed', userId, [], input.name);
  }
  if (input.description !== undefined) conv.groupDescription = input.description;
  if (input.permissions) conv.permissions = { ...conv.permissions, ...input.permissions };
  await conv.save();
  await pushConversation(conv.participants.map(String), conversationId, 'conversation:updated');
  return loadSerializedConversation(conversationId, userId);
}

export async function setGroupImage(userId: string, conversationId: string, image: { key: string; provider: 'local' | 'cloudinary'; resourceType?: string } | null) {
  const conv = await getConversationForMember(conversationId, userId);
  assertGroup(conv);
  if (conv.permissions.onlyAdminsCanEditInfo && !isAdmin(conv, userId)) throw ApiError.forbidden('Only admins can edit group info');
  const previous = conv.groupImage;
  conv.groupImage = image;
  await conv.save();
  if (previous?.key) driverFor(previous.provider).remove(previous, 'public').catch(() => undefined);
  await createSystemMessage(conv, image ? 'icon_changed' : 'icon_removed', userId);
  await pushConversation(conv.participants.map(String), conversationId, 'conversation:updated');
  return loadSerializedConversation(conversationId, userId);
}

export async function addMembers(userId: string, conversationId: string, memberIds: string[]) {
  const conv = await getConversationForMember(conversationId, userId);
  assertGroup(conv);
  if (conv.permissions.onlyAdminsCanAddMembers && !isAdmin(conv, userId)) throw ApiError.forbidden('Only admins can add members');
  const toAdd = [...new Set(memberIds)].filter((id) => !has(conv.participants, id));
  if (toAdd.length === 0) throw ApiError.badRequest('These users are already members');
  if (conv.participants.length + toAdd.length > MAX_GROUP_MEMBERS) throw ApiError.badRequest(`Groups are limited to ${MAX_GROUP_MEMBERS} members`);
  const friendIds = new Set(await getFriendIds(userId));
  if (toAdd.some((id) => !friendIds.has(id))) throw ApiError.badRequest('You can only add your friends');

  const now = new Date();
  await Conversation.updateOne(
    { _id: conv._id },
    {
      $addToSet: { participants: { $each: toAdd.map(oid) } },
      $push: { memberMeta: { $each: toAdd.map((u) => ({ user: oid(u), joinedAt: now, lastReadAt: now })) } },
    },
  );
  const fresh = (await Conversation.findById(conv._id))!;
  joinConversationRoom(toAdd, conversationId);
  await createSystemMessage(fresh, 'added', userId, toAdd);
  await pushConversation(toAdd, conversationId, 'conversation:new');
  await pushConversation(conv.participants.map(String), conversationId, 'conversation:updated');
  for (const m of toAdd) {
    void notify(m, { type: 'group_invite', title: fresh.groupName ?? 'Group', body: 'You were added to the group', data: { conversationId } }, { socket: false });
  }
  return loadSerializedConversation(conversationId, userId);
}

/**
 * Removes a member. If actor === member it is "leave group".
 * When the last admin leaves, the longest-standing member becomes admin.
 * When the last member leaves, the group is deleted.
 */
export async function removeMemberFromGroup(conversationId: string, actorId: string, memberId: string, _opts: { silent?: boolean } = {}) {
  const conv = await getConversationForMember(conversationId, actorId);
  assertGroup(conv);
  const leaving = actorId === memberId;
  if (!leaving && !isAdmin(conv, actorId)) throw ApiError.forbidden('Only admins can remove members');
  if (!has(conv.participants, memberId)) throw ApiError.notFound('User is not a member');

  conv.participants = conv.participants.filter((p) => String(p) !== memberId);
  conv.admins = conv.admins.filter((a) => String(a) !== memberId);
  conv.memberMeta = conv.memberMeta.filter((m) => String(m.user) !== memberId);

  if (conv.participants.length === 0) {
    await deleteConversationData(conv);
    leaveConversationRoom([memberId], conversationId);
    emitToUser(memberId, 'conversation:removed', { conversationId });
    return;
  }
  let promoted: string | null = null;
  if (conv.admins.length === 0) {
    const oldest = [...conv.memberMeta].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
    if (oldest) {
      conv.admins = [oldest.user];
      promoted = String(oldest.user);
    }
  }
  await conv.save();
  leaveConversationRoom([memberId], conversationId);
  emitToUser(memberId, 'conversation:removed', { conversationId });
  await createSystemMessage(conv, leaving ? 'left' : 'removed', actorId, leaving ? [] : [memberId]);
  if (promoted) await createSystemMessage(conv, 'promoted', null, [promoted]);
  await pushConversation(conv.participants.map(String), conversationId, 'conversation:updated');
}

export async function setAdmin(actorId: string, conversationId: string, memberId: string, makeAdmin: boolean) {
  const conv = await getConversationForMember(conversationId, actorId);
  assertGroup(conv);
  if (!isAdmin(conv, actorId)) throw ApiError.forbidden('Only admins can manage admins');
  if (!has(conv.participants, memberId)) throw ApiError.notFound('User is not a member');
  if (makeAdmin) {
    if (isAdmin(conv, memberId)) return loadSerializedConversation(conversationId, actorId);
    conv.admins.push(oid(memberId));
  } else {
    if (conv.admins.length === 1 && isAdmin(conv, memberId)) throw ApiError.badRequest('A group needs at least one admin');
    conv.admins = conv.admins.filter((a) => String(a) !== memberId);
  }
  await conv.save();
  await createSystemMessage(conv, makeAdmin ? 'promoted' : 'demoted', actorId, [memberId]);
  await pushConversation(conv.participants.map(String), conversationId, 'conversation:updated');
  return loadSerializedConversation(conversationId, actorId);
}

export async function deleteConversationData(conv: ConversationDoc) {
  const files = await Message.find({ conversationId: conv._id, attachment: { $ne: null } }).select('attachment').lean();
  await Message.deleteMany({ conversationId: conv._id });
  await Conversation.deleteOne({ _id: conv._id });
  for (const f of files) {
    if (!f.attachment) continue;
    // Forwarded copies elsewhere may still reference this file.
    const stillUsed = await Message.exists({ 'attachment.key': f.attachment.key });
    if (!stillUsed) driverFor(f.attachment.provider).remove(f.attachment, 'private').catch(() => undefined);
  }
  if (conv.groupImage?.key) driverFor(conv.groupImage.provider).remove(conv.groupImage, 'public').catch(() => undefined);
}

export async function deleteGroup(actorId: string, conversationId: string) {
  const conv = await getConversationForMember(conversationId, actorId);
  assertGroup(conv);
  if (!isAdmin(conv, actorId)) throw ApiError.forbidden('Only admins can delete the group');
  const members = conv.participants.map(String);
  await deleteConversationData(conv);
  emitToUser(members, 'conversation:removed', { conversationId });
  leaveConversationRoom(members, conversationId);
}

export async function clearHistory(userId: string, conversationId: string) {
  await getConversationForMember(conversationId, userId);
  const now = new Date();
  await Conversation.updateOne(
    { _id: conversationId, 'memberMeta.user': oid(userId) },
    { $set: { 'memberMeta.$.clearedAt': now, 'memberMeta.$.lastReadAt': now } },
  );
  const data = await loadSerializedConversation(conversationId, userId);
  emitToUser(userId, 'conversation:updated', data);
  return data;
}
