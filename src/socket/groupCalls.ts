import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { Types } from 'mongoose';
import { User } from '../models/User';
import { objectId } from '../middleware/validate';
import { getConversationForMember } from '../services/conversations';
import { getIceServers } from '../services/ice';
import { emitToUser } from '../services/realtime';
import { notify } from '../services/notifications';
import { fileUrl } from '../services/storage';
import { ApiError } from '../utils/errors';

/** Mesh WebRTC: every participant connects directly to every other one, so keep groups small. */
export const MAX_GROUP_CALL_PARTICIPANTS = 6;
const MAX_SIGNAL_BYTES = 64 * 1024;

interface PeerInfo {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string | null;
}

interface GroupCall {
  id: string;
  conversationId: string;
  groupName: string;
  callType: 'audio' | 'video';
  startedBy: PeerInfo;
  memberIds: string[];
  participants: Map<string, { socketId: string; info: PeerInfo }>;
}

/** In-memory (single instance), like 1:1 calls. */
const groupCalls = new Map<string, GroupCall>();
const byConversation = new Map<string, string>();
const userGroupCall = new Map<string, string>();

type Ack = (res: Record<string, unknown>) => void;
const safeAck = (ack: unknown): Ack => (typeof ack === 'function' ? (ack as Ack) : () => undefined);

const startSchema = z.object({ conversationId: objectId, callType: z.enum(['audio', 'video']) });
const callIdSchema = z.object({ callId: objectId });
const signalSchema = z.object({
  callId: objectId,
  to: objectId,
  payload: z.object({ type: z.enum(['offer', 'answer', 'candidate', 'share']) }).passthrough(),
});

const incomingPayload = (gc: GroupCall) => ({
  callId: gc.id,
  conversationId: gc.conversationId,
  groupName: gc.groupName,
  callType: gc.callType,
  startedBy: gc.startedBy,
  participantCount: gc.participants.size,
});

async function loadPeerInfo(userId: string): Promise<PeerInfo> {
  const u = await User.findById(userId).select('username displayName avatar').lean();
  if (!u) throw ApiError.notFound('User not found');
  return { id: userId, username: u.username, displayName: u.displayName, avatarUrl: fileUrl(u.avatar, 'public') };
}

function removeParticipant(io: Server, gc: GroupCall, userId: string) {
  if (!gc.participants.delete(userId)) return;
  if (userGroupCall.get(userId) === gc.id) userGroupCall.delete(userId);
  for (const p of gc.participants.values()) io.to(p.socketId).emit('gcall:peer-left', { callId: gc.id, userId });
  if (gc.participants.size === 0) {
    groupCalls.delete(gc.id);
    if (byConversation.get(gc.conversationId) === gc.id) byConversation.delete(gc.conversationId);
    emitToUser(gc.memberIds, 'gcall:ended', { callId: gc.id, conversationId: gc.conversationId });
  }
}

/** Re-sends ongoing group calls to a device that just connected. */
export function resendGroupCalls(socket: Socket) {
  const userId: string = socket.data.userId;
  for (const gc of groupCalls.values()) {
    if (gc.memberIds.includes(userId) && !gc.participants.has(userId)) socket.emit('gcall:incoming', incomingPayload(gc));
  }
}

export function handleGroupCallDisconnect(io: Server, socket: Socket) {
  const userId: string = socket.data.userId;
  const callId = userGroupCall.get(userId);
  const gc = callId ? groupCalls.get(callId) : undefined;
  if (gc && gc.participants.get(userId)?.socketId === socket.id) removeParticipant(io, gc, userId);
}

export function registerGroupCallHandlers(io: Server, socket: Socket) {
  const userId: string = socket.data.userId;

  socket.on('gcall:start', async (raw, ackFn) => {
    const ack = safeAck(ackFn);
    try {
      const { conversationId, callType } = startSchema.parse(raw);
      const conv = await getConversationForMember(conversationId, userId);
      if (conv.type !== 'group') throw ApiError.badRequest('Group calls are only available in groups');
      if (userGroupCall.has(userId)) throw ApiError.conflict('You are already in a group call');
      const existing = byConversation.get(conversationId);
      if (existing && groupCalls.has(existing)) throw ApiError.conflict('A call is already in progress in this group');

      const me = await loadPeerInfo(userId);
      const gc: GroupCall = {
        id: new Types.ObjectId().toString(),
        conversationId,
        groupName: conv.groupName ?? 'Group',
        callType,
        startedBy: me,
        memberIds: conv.participants.map(String),
        participants: new Map([[userId, { socketId: socket.id, info: me }]]),
      };
      groupCalls.set(gc.id, gc);
      byConversation.set(conversationId, gc.id);
      userGroupCall.set(userId, gc.id);

      const others = gc.memberIds.filter((id) => id !== userId);
      emitToUser(others, 'gcall:incoming', incomingPayload(gc));
      for (const m of others) {
        void notify(
          m,
          {
            type: 'incoming_call',
            title: `${gc.groupName}: group ${callType} call`,
            body: `${me.displayName} started a group ${callType} call`,
            data: { callId: gc.id, callType, conversationId },
          },
          { socket: false },
        );
      }
      ack({ ok: true, callId: gc.id, iceServers: getIceServers(userId), peers: [] });
    } catch (err) {
      ack({ ok: false, error: err instanceof ApiError ? err.message : 'Could not start the call' });
    }
  });

  socket.on('gcall:join', async (raw, ackFn) => {
    const ack = safeAck(ackFn);
    try {
      const { callId } = callIdSchema.parse(raw);
      const gc = groupCalls.get(callId);
      if (!gc) throw ApiError.notFound('This call has ended');
      if (!gc.memberIds.includes(userId)) throw ApiError.forbidden("You're not in this group");
      const current = userGroupCall.get(userId);
      if (current && current !== callId) throw ApiError.conflict('You are already in another group call');
      if (!gc.participants.has(userId) && gc.participants.size >= MAX_GROUP_CALL_PARTICIPANTS) {
        throw ApiError.badRequest(`Group calls are limited to ${MAX_GROUP_CALL_PARTICIPANTS} people`);
      }
      const me = await loadPeerInfo(userId);
      const peers = [...gc.participants.values()].filter((p) => p.info.id !== userId).map((p) => p.info);
      gc.participants.set(userId, { socketId: socket.id, info: me });
      userGroupCall.set(userId, gc.id);
      for (const p of gc.participants.values()) {
        if (p.info.id !== userId) io.to(p.socketId).emit('gcall:peer-joined', { callId, user: me });
      }
      ack({ ok: true, callId, callType: gc.callType, conversationId: gc.conversationId, iceServers: getIceServers(userId), peers });
    } catch (err) {
      ack({ ok: false, error: err instanceof ApiError ? err.message : 'Could not join the call' });
    }
  });

  socket.on('gcall:leave', (raw, ackFn) => {
    const ack = safeAck(ackFn);
    const parsed = callIdSchema.safeParse(raw);
    const gc = parsed.success ? groupCalls.get(parsed.data.callId) : undefined;
    if (gc) removeParticipant(io, gc, userId);
    ack({ ok: true });
  });

  socket.on('gcall:signal', (raw) => {
    const parsed = signalSchema.safeParse(raw);
    if (!parsed.success) return;
    if (Buffer.byteLength(JSON.stringify(parsed.data.payload)) > MAX_SIGNAL_BYTES) return;
    const gc = groupCalls.get(parsed.data.callId);
    const me = gc?.participants.get(userId);
    const target = gc?.participants.get(parsed.data.to);
    if (!gc || !me || me.socketId !== socket.id || !target) return;
    io.to(target.socketId).emit('gcall:signal', { callId: gc.id, from: userId, payload: parsed.data.payload });
  });
}
