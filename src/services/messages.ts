/* eslint-disable @typescript-eslint/no-explicit-any */
import { Types } from 'mongoose';
import { Conversation } from '../models/Conversation';
import { Message, Attachment, MessageType } from '../models/Message';
import { User } from '../models/User';
import { getSettings } from '../models/UserSettings';
import { ApiError } from '../utils/errors';
import { MESSAGE_POPULATE, serializeMessage, SerializedMessage } from '../utils/serializers';
import { verifyPayload } from '../utils/tokens';
import { getConversationForMember, historyFloor, isAdmin } from './conversations';
import { isBlockedEitherWay } from './relationships';
import { emitToConversation, emitToUser } from './realtime';
import { notify } from './notifications';
import { driverFor } from './storage';

const oid = (id: string | Types.ObjectId) => new Types.ObjectId(String(id));
const EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_PINS = 10;

export interface UploadTokenPayload {
  uid: string;
  mt: MessageType;
  a: Attachment;
}

export interface SendMessageInput {
  conversationId: string;
  clientId?: string;
  content?: string;
  uploadToken?: string;
  replyTo?: string;
  forwardFrom?: string;
}

async function loadSerialized(messageId: Types.ObjectId | string): Promise<SerializedMessage> {
  const m = await Message.findById(messageId).populate(MESSAGE_POPULATE).lean();
  return serializeMessage(m)!;
}

function previewText(m: SerializedMessage): string {
  switch (m.messageType) {
    case 'image':
      return m.content ? `📷 ${m.content}` : '📷 Photo';
    case 'video':
      return m.content ? `🎥 ${m.content}` : '🎥 Video';
    case 'voice':
      return '🎤 Voice message';
    case 'audio':
      return '🎵 Audio';
    case 'file':
      return `📄 ${m.attachment?.name ?? 'File'}`;
    default:
      return m.content.slice(0, 120);
  }
}

export async function sendMessage(userId: string, input: SendMessageInput): Promise<SerializedMessage> {
  if (input.clientId) {
    const existing = await Message.findOne({ senderId: userId, clientId: input.clientId }).select('_id').lean();
    if (existing) return loadSerialized(existing._id);
  }

  const conv = await getConversationForMember(input.conversationId, userId);
  if (conv.type === 'private') {
    const other = conv.participants.find((p) => String(p) !== userId);
    if (other && (await isBlockedEitherWay(userId, other))) throw ApiError.forbidden("You can't message this user");
  } else if (conv.permissions.onlyAdminsCanMessage && !isAdmin(conv, userId)) {
    throw ApiError.forbidden('Only admins can send messages in this group');
  }

  let messageType: MessageType = 'text';
  let content = (input.content ?? '').trim();
  let attachment: Attachment | null = null;
  let forwarded = false;

  if (input.forwardFrom) {
    const orig = await Message.findById(input.forwardFrom).lean();
    if (!orig || orig.deletedAt || orig.deletedFor.some((x) => String(x) === userId)) throw ApiError.notFound('Message not found');
    if (!(await Conversation.exists({ _id: orig.conversationId, participants: userId }))) throw ApiError.notFound('Message not found');
    if (orig.messageType === 'system' || orig.messageType === 'call') throw ApiError.badRequest("This message can't be forwarded");
    messageType = orig.messageType;
    content = orig.content;
    attachment = orig.attachment ?? null;
    forwarded = true;
  } else if (input.uploadToken) {
    const up = verifyPayload<UploadTokenPayload>(input.uploadToken);
    if (!up || up.uid !== userId) throw ApiError.badRequest('Attachment is invalid or expired, please upload it again');
    attachment = up.a;
    messageType = up.mt;
  }

  if (!content && !attachment) throw ApiError.badRequest('Message is empty');
  if (content.length > 4000) throw ApiError.badRequest('Message is too long (max 4000 characters)');

  let replyTo: Types.ObjectId | null = null;
  if (input.replyTo) {
    if (!Types.ObjectId.isValid(input.replyTo) || !(await Message.exists({ _id: input.replyTo, conversationId: conv._id }))) {
      throw ApiError.badRequest('The message you are replying to no longer exists');
    }
    replyTo = oid(input.replyTo);
  }

  let created;
  try {
    created = await Message.create({
      conversationId: conv._id,
      senderId: oid(userId),
      messageType,
      content,
      attachment,
      replyTo,
      forwarded,
      clientId: input.clientId,
    });
  } catch (err: any) {
    if (err?.code === 11000 && input.clientId) {
      const existing = await Message.findOne({ senderId: userId, clientId: input.clientId }).select('_id').lean();
      if (existing) return loadSerialized(existing._id);
    }
    throw err;
  }

  await Conversation.updateOne(
    { _id: conv._id },
    { $set: { lastMessage: created._id, lastMessageAt: created.createdAt, 'memberMeta.$[m].lastReadAt': created.createdAt } },
    { arrayFilters: [{ 'm.user': oid(userId) }] },
  );

  const payload = await loadSerialized(created._id);
  emitToConversation(String(conv._id), 'message:new', payload);

  // Push notifications to recipients' offline devices.
  const recipients = conv.participants.map(String).filter((id) => id !== userId);
  const sender = payload.sender;
  const isGroup = conv.type === 'group';
  for (const rid of recipients) {
    void notify(
      rid,
      {
        type: isGroup ? 'group_message' : 'message',
        title: isGroup ? conv.groupName ?? 'Group' : sender?.displayName ?? 'New message',
        body: isGroup ? `${sender?.displayName ?? 'Someone'}: ${previewText(payload)}` : previewText(payload),
        data: { conversationId: String(conv._id), messageId: payload.id },
      },
      { socket: false },
    );
  }
  return payload;
}

export async function listMessages(userId: string, conversationId: string, opts: { before?: string; limit: number }) {
  const conv = await getConversationForMember(conversationId, userId);
  const filter: Record<string, any> = { conversationId: conv._id, deletedFor: { $ne: oid(userId) } };
  const createdAt: Record<string, Date> = {};
  if (opts.before) createdAt.$lt = new Date(opts.before);
  const floor = historyFloor(conv, userId);
  if (floor) createdAt.$gt = floor;
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;

  const rows = await Message.find(filter)
    .sort({ createdAt: -1 })
    .limit(opts.limit + 1)
    .populate(MESSAGE_POPULATE)
    .lean();
  const hasMore = rows.length > opts.limit;
  return { messages: rows.slice(0, opts.limit).reverse().map((m) => serializeMessage(m)!), hasMore };
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export async function searchMessages(userId: string, conversationId: string, q: string) {
  const conv = await getConversationForMember(conversationId, userId);
  const filter: Record<string, any> = {
    conversationId: conv._id,
    deletedAt: null,
    deletedFor: { $ne: oid(userId) },
    messageType: { $nin: ['system', 'call'] },
    $or: [{ content: { $regex: escapeRegex(q), $options: 'i' } }, { 'attachment.name': { $regex: escapeRegex(q), $options: 'i' } }],
  };
  const floor = historyFloor(conv, userId);
  if (floor) filter.createdAt = { $gt: floor };
  const rows = await Message.find(filter).sort({ createdAt: -1 }).limit(50).populate(MESSAGE_POPULATE).lean();
  return rows.map((m) => serializeMessage(m)!);
}

const MEDIA_KINDS: Record<string, MessageType[]> = {
  media: ['image', 'video'],
  files: ['file'],
  audio: ['audio', 'voice'],
};

export async function listMedia(userId: string, conversationId: string, kind: string, before?: string) {
  const conv = await getConversationForMember(conversationId, userId);
  const filter: Record<string, any> = {
    conversationId: conv._id,
    messageType: { $in: MEDIA_KINDS[kind] ?? MEDIA_KINDS.media },
    deletedAt: null,
    deletedFor: { $ne: oid(userId) },
  };
  const createdAt: Record<string, Date> = {};
  if (before) createdAt.$lt = new Date(before);
  const floor = historyFloor(conv, userId);
  if (floor) createdAt.$gt = floor;
  if (Object.keys(createdAt).length) filter.createdAt = createdAt;
  const rows = await Message.find(filter).sort({ createdAt: -1 }).limit(61).populate(MESSAGE_POPULATE).lean();
  return { items: rows.slice(0, 60).map((m) => serializeMessage(m)!), hasMore: rows.length > 60 };
}

export async function listPinned(userId: string, conversationId: string) {
  const conv = await getConversationForMember(conversationId, userId);
  const rows = await Message.find({ _id: { $in: conv.pinnedMessages }, deletedAt: null }).populate(MESSAGE_POPULATE).lean();
  return rows.map((m) => serializeMessage(m)!);
}

// ---------- Receipts ----------

/** Marks messages as delivered to `userId` and notifies senders. */
async function applyDelivered(userId: string, rows: { _id: Types.ObjectId; conversationId: Types.ObjectId }[]) {
  if (rows.length === 0) return;
  const at = new Date();
  await Message.updateMany(
    { _id: { $in: rows.map((r) => r._id) }, 'deliveredTo.user': { $ne: oid(userId) } },
    { $push: { deliveredTo: { user: oid(userId), at } } },
  );
  const byConv = new Map<string, string[]>();
  for (const r of rows) {
    const k = String(r.conversationId);
    byConv.set(k, [...(byConv.get(k) ?? []), String(r._id)]);
  }
  for (const [conversationId, messageIds] of byConv) {
    emitToConversation(conversationId, 'message:receipt', { conversationId, messageIds, userId, kind: 'delivered', at: at.toISOString() });
  }
}

export async function markDelivered(userId: string, messageIds: string[]) {
  const ids = messageIds.filter((id) => Types.ObjectId.isValid(id)).slice(0, 500);
  if (ids.length === 0) return;
  const myConvs = await Conversation.find({ participants: userId }).distinct('_id');
  const rows = await Message.find({
    _id: { $in: ids.map(oid) },
    conversationId: { $in: myConvs },
    senderId: { $nin: [oid(userId), null] },
    'deliveredTo.user': { $ne: oid(userId) },
  })
    .select('_id conversationId')
    .lean();
  await applyDelivered(userId, rows);
}

/** Called when a device connects: everything sent while the user was offline is now delivered. */
export async function deliverPending(userId: string) {
  const myConvs = await Conversation.find({ participants: userId }).distinct('_id');
  if (myConvs.length === 0) return;
  const rows = await Message.find({
    conversationId: { $in: myConvs },
    senderId: { $nin: [oid(userId), null] },
    'deliveredTo.user': { $ne: oid(userId) },
    deletedAt: null,
    createdAt: { $gt: new Date(Date.now() - 30 * 86400_000) },
  })
    .select('_id conversationId')
    .limit(2000)
    .lean();
  await applyDelivered(userId, rows);
}

export async function markConversationRead(userId: string, conversationId: string) {
  const conv = await getConversationForMember(conversationId, userId);
  const now = new Date();
  await Conversation.updateOne({ _id: conv._id, 'memberMeta.user': oid(userId) }, { $set: { 'memberMeta.$.lastReadAt': now } });
  emitToUser(userId, 'conversation:read-sync', { conversationId, at: now.toISOString() });

  const settings = await getSettings(userId);
  const rows = await Message.find({
    conversationId: conv._id,
    senderId: { $nin: [oid(userId), null] },
    'readBy.user': { $ne: oid(userId) },
    deletedAt: null,
    createdAt: { $lte: now },
  })
    .select('_id conversationId deliveredTo')
    .sort({ createdAt: -1 })
    .limit(500)
    .lean();
  if (rows.length === 0) return;

  // Reading implies delivery.
  const undelivered = rows.filter((r) => !r.deliveredTo.some((d) => String(d.user) === userId));
  await applyDelivered(userId, undelivered);

  // Read receipts are only shared if the reader allows it.
  if (!settings.privacy.readReceipts) return;
  const ids = rows.map((r) => r._id);
  await Message.updateMany({ _id: { $in: ids }, 'readBy.user': { $ne: oid(userId) } }, { $push: { readBy: { user: oid(userId), at: now } } });
  emitToConversation(conversationId, 'message:receipt', {
    conversationId,
    messageIds: ids.map(String),
    userId,
    kind: 'read',
    at: now.toISOString(),
  });
}

// ---------- Mutations ----------

async function getMessageForMember(userId: string, messageId: string) {
  if (!Types.ObjectId.isValid(messageId)) throw ApiError.notFound('Message not found');
  const msg = await Message.findById(messageId);
  if (!msg || msg.deletedFor.some((x) => String(x) === userId)) throw ApiError.notFound('Message not found');
  const conv = await getConversationForMember(String(msg.conversationId), userId);
  return { msg, conv };
}

export async function editMessage(userId: string, messageId: string, content: string) {
  const { msg } = await getMessageForMember(userId, messageId);
  if (String(msg.senderId) !== userId) throw ApiError.forbidden('You can only edit your own messages');
  if (msg.deletedAt) throw ApiError.badRequest('This message was deleted');
  if (msg.forwarded) throw ApiError.badRequest("Forwarded messages can't be edited");
  if (!['text', 'image', 'video', 'file'].includes(msg.messageType)) throw ApiError.badRequest("This message can't be edited");
  if (Date.now() - msg.createdAt.getTime() > EDIT_WINDOW_MS) throw ApiError.badRequest('Messages can only be edited within 24 hours');
  const trimmed = content.trim();
  if (!trimmed && msg.messageType === 'text') throw ApiError.badRequest('Message is empty');
  msg.content = trimmed;
  msg.editedAt = new Date();
  await msg.save();
  const payload = await loadSerialized(msg._id);
  emitToConversation(String(msg.conversationId), 'message:updated', payload);
  return payload;
}

export async function deleteMessage(userId: string, messageId: string, scope: 'me' | 'everyone') {
  const { msg, conv } = await getMessageForMember(userId, messageId);
  const conversationId = String(msg.conversationId);

  if (scope === 'me') {
    await Message.updateOne({ _id: msg._id }, { $addToSet: { deletedFor: oid(userId) } });
    emitToUser(userId, 'message:deleted', { conversationId, messageId, scope: 'me' });
    return;
  }

  const isSender = String(msg.senderId) === userId;
  const canModerate = conv.type === 'group' && isAdmin(conv, userId);
  if (!isSender && !canModerate) throw ApiError.forbidden('You can only delete your own messages for everyone');
  if (msg.deletedAt) return;

  const attachment = msg.attachment;
  msg.deletedAt = new Date();
  msg.content = '';
  msg.attachment = null;
  msg.reactions = [];
  await msg.save();
  await Conversation.updateOne({ _id: conv._id }, { $pull: { pinnedMessages: msg._id } });

  if (attachment) {
    const stillUsed = await Message.exists({ 'attachment.key': attachment.key });
    if (!stillUsed) driverFor(attachment.provider).remove(attachment, 'private').catch(() => undefined);
  }
  emitToConversation(conversationId, 'message:deleted', { conversationId, messageId, scope: 'everyone', message: await loadSerialized(msg._id) });
}

export async function toggleReaction(userId: string, messageId: string, emoji: string) {
  const { msg } = await getMessageForMember(userId, messageId);
  if (msg.deletedAt) throw ApiError.badRequest('This message was deleted');
  if (msg.messageType === 'system') throw ApiError.badRequest("You can't react to this message");
  const existing = msg.reactions.find((r) => String(r.user) === userId);
  msg.reactions = msg.reactions.filter((r) => String(r.user) !== userId);
  if (!existing || existing.emoji !== emoji) msg.reactions.push({ user: oid(userId), emoji });
  await msg.save();
  const reactions = msg.reactions.map((r) => ({ userId: String(r.user), emoji: r.emoji }));
  emitToConversation(String(msg.conversationId), 'message:reaction', { conversationId: String(msg.conversationId), messageId, reactions });
  return reactions;
}

export async function setPinned(userId: string, messageId: string, pinned: boolean) {
  const { msg, conv } = await getMessageForMember(userId, messageId);
  if (msg.deletedAt) throw ApiError.badRequest('This message was deleted');
  if (conv.type === 'group' && conv.permissions.onlyAdminsCanEditInfo && !isAdmin(conv, userId)) {
    throw ApiError.forbidden('Only admins can pin messages in this group');
  }
  if (pinned) {
    if (conv.pinnedMessages.length >= MAX_PINS && !conv.pinnedMessages.some((p) => String(p) === messageId)) {
      throw ApiError.badRequest(`You can pin up to ${MAX_PINS} messages`);
    }
    await Conversation.updateOne({ _id: conv._id }, { $addToSet: { pinnedMessages: msg._id } });
  } else {
    await Conversation.updateOne({ _id: conv._id }, { $pull: { pinnedMessages: msg._id } });
  }
  const fresh = await Conversation.findById(conv._id).select('pinnedMessages').lean();
  const pinnedMessageIds = (fresh?.pinnedMessages ?? []).map(String);
  const actor = await User.findById(userId).select('displayName').lean();
  emitToConversation(String(conv._id), 'message:pinned', {
    conversationId: String(conv._id),
    messageId,
    pinned,
    pinnedMessageIds,
    by: actor?.displayName ?? null,
  });
  return pinnedMessageIds;
}
