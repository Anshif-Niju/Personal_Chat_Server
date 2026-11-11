/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { User } from '../models/User';
import { UserSettings } from '../models/UserSettings';
import { UserSession } from '../models/UserSession';
import { FriendRequest } from '../models/FriendRequest';
import { Block } from '../models/Block';
import { Call } from '../models/Call';
import { Conversation } from '../models/Conversation';
import { Message } from '../models/Message';
import { ApiError } from '../utils/errors';
import { env } from '../config/env';
import { deleteConversationData, pushConversation } from './conversations';
import { getFriendIds } from './relationships';
import { revokeSessions } from './auth';
import { driverFor } from './storage';
import { emitToUser, emitToConversation, leaveConversationRoom } from './realtime';

export const isAdminUsername = (username: string) => env.adminUsernames.includes(username.toLowerCase());

const oid = (id: string) => new Types.ObjectId(id);

/** Deletes an uploaded file unless another message still references it (e.g. a forwarded copy). */
async function removeAttachmentIfUnused(att: any, deletedMessageIds: Types.ObjectId[]) {
  if (!att?.key) return;
  const stillUsed = await Message.exists({ 'attachment.key': att.key, _id: { $nin: deletedMessageIds } });
  if (!stillUsed) driverFor(att.provider).remove(att, 'private').catch(() => undefined);
}

/** Permanently deletes everything a user ever posted, in every chat. */
async function deleteMessagesBy(userId: string) {
  const msgs = await Message.find({ senderId: userId }).select('_id attachment conversationId').lean();
  if (msgs.length === 0) return;
  const ids = msgs.map((m) => m._id);
  for (const m of msgs) await removeAttachmentIfUnused(m.attachment, ids);
  await Message.deleteMany({ _id: { $in: ids } });
  for (const convId of new Set(msgs.map((m) => String(m.conversationId)))) {
    const last = await Message.findOne({ conversationId: convId }).sort({ createdAt: -1 }).select('_id createdAt').lean();
    await Conversation.updateOne({ _id: convId }, { lastMessage: last?._id ?? null, ...(last ? { lastMessageAt: last.createdAt } : {}) });
  }
}

/**
 * HARD delete: removes the account, its sessions (so it can't log in), friendships, blocks, calls,
 * all of its messages and files, its private chats, and its membership in groups.
 */
export async function hardDeleteUser(userId: string) {
  const user = await User.findById(userId);
  if (!user) throw ApiError.notFound('User not found');
  if (isAdminUsername(user.username)) throw ApiError.badRequest("Admin accounts can't be deleted here");

  const friendIds = await getFriendIds(userId);
  const convs = await Conversation.find({ participants: userId });
  const touchedGroups: string[] = [];

  for (const conv of convs) {
    const members = conv.participants.map(String);
    const remaining = members.filter((m) => m !== userId);
    if (conv.type === 'private' || remaining.length === 0) {
      await deleteConversationData(conv);
      emitToUser(members, 'conversation:removed', { conversationId: String(conv._id) });
      leaveConversationRoom(members, String(conv._id));
      continue;
    }
    // Group: remove the member, hand over admin if needed.
    conv.participants = conv.participants.filter((p) => String(p) !== userId);
    conv.admins = conv.admins.filter((a) => String(a) !== userId);
    conv.memberMeta = conv.memberMeta.filter((m) => String(m.user) !== userId);
    if (conv.admins.length === 0) {
      const oldest = [...conv.memberMeta].sort((a, b) => a.joinedAt.getTime() - b.joinedAt.getTime())[0];
      if (oldest) conv.admins = [oldest.user];
    }
    await conv.save();
    leaveConversationRoom([userId], String(conv._id));
    touchedGroups.push(String(conv._id));
  }

  await deleteMessagesBy(userId);
  await Message.updateMany({ 'reactions.user': userId }, { $pull: { reactions: { user: oid(userId) } } });
  await Message.updateMany({ 'readBy.user': userId }, { $pull: { readBy: { user: oid(userId) }, deliveredTo: { user: oid(userId) } } });

  await Promise.all([
    FriendRequest.deleteMany({ $or: [{ senderId: userId }, { receiverId: userId }] }),
    Block.deleteMany({ $or: [{ blocker: userId }, { blocked: userId }] }),
    Call.deleteMany({ $or: [{ callerId: userId }, { receiverId: userId }] }),
    UserSettings.deleteOne({ userId }),
  ]);
  await revokeSessions({ userId }); // disconnects their sockets
  await UserSession.deleteMany({ userId });
  if (user.avatar?.key) driverFor(user.avatar.provider).remove(user.avatar, 'public').catch(() => undefined);
  await user.deleteOne();

  emitToUser(friendIds, 'friend:removed', { userId });
  for (const gid of touchedGroups) {
    const c = await Conversation.findById(gid).select('participants').lean();
    if (c) await pushConversation(c.participants.map(String), gid, 'conversation:updated');
  }
}

/** Hard-deletes one message (and its file). */
export async function hardDeleteMessage(messageId: string) {
  const msg = await Message.findById(messageId).lean();
  if (!msg) throw ApiError.notFound('Message not found');
  await removeAttachmentIfUnused(msg.attachment, [msg._id]);
  await Message.deleteOne({ _id: msg._id });
  const last = await Message.findOne({ conversationId: msg.conversationId }).sort({ createdAt: -1 }).select('_id createdAt').lean();
  await Conversation.updateOne({ _id: msg.conversationId }, { lastMessage: last?._id ?? null, ...(last ? { lastMessageAt: last.createdAt } : {}) });
  emitToConversation(String(msg.conversationId), 'message:deleted', {
    conversationId: String(msg.conversationId),
    messageId: String(msg._id),
    scope: 'everyone',
  });
}

/** Hard-deletes a whole chat (private or group) with every message and file. */
export async function hardDeleteConversation(conversationId: string) {
  const conv = await Conversation.findById(conversationId);
  if (!conv) throw ApiError.notFound('Chat not found');
  const members = conv.participants.map(String);
  await deleteConversationData(conv);
  emitToUser(members, 'conversation:removed', { conversationId });
  leaveConversationRoom(members, conversationId);
}
