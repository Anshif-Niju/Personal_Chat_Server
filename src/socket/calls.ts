import type { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { Types } from 'mongoose';
import { Call, CallStatus } from '../models/Call';
import { Conversation, privateKeyFor } from '../models/Conversation';
import { Message } from '../models/Message';
import { User } from '../models/User';
import { getSettings } from '../models/UserSettings';
import { objectId } from '../middleware/validate';
import { areFriends, isBlockedEitherWay } from '../services/relationships';
import { getOrCreatePrivate } from '../services/conversations';
import { getIceServers } from '../services/ice';
import { emitToConversation, emitToUser, userRoom } from '../services/realtime';
import { notify } from '../services/notifications';
import { fileUrl } from '../services/storage';
import { MESSAGE_POPULATE, serializeMessage } from '../utils/serializers';
import { ApiError } from '../utils/errors';

const RING_TIMEOUT_MS = 45_000;
const RECONNECT_GRACE_MS = 20_000;
const MAX_SIGNAL_BYTES = 64 * 1024;

interface ActiveCall {
  id: string;
  callerId: string;
  calleeId: string;
  callType: 'audio' | 'video';
  conversationId: string;
  status: 'ringing' | 'ongoing';
  callerSocket: string;
  calleeSocket: string | null;
  startedAt: Date | null;
  ringTimer?: NodeJS.Timeout;
  grace: Map<string, NodeJS.Timeout>;
  callerInfo: { id: string; username: string; displayName: string; avatarUrl: string | null };
}

/**
 * In-memory registry of active calls (single instance).
 * For horizontal scaling move this to Redis together with the Socket.IO Redis adapter.
 */
const calls = new Map<string, ActiveCall>();
const userCalls = new Map<string, string>();

type Ack = (res: Record<string, unknown>) => void;
const safeAck = (ack: unknown): Ack => (typeof ack === 'function' ? (ack as Ack) : () => undefined);

const initiateSchema = z.object({ calleeId: objectId, callType: z.enum(['audio', 'video']) });
const callIdSchema = z.object({ callId: objectId });
const signalSchema = z.object({
  callId: objectId,
  payload: z.object({ type: z.enum(['offer', 'answer', 'candidate', 'share']) }).passthrough(),
});

async function finalizeCall(callId: string, status: CallStatus) {
  const call = calls.get(callId);
  if (!call) return;
  calls.delete(callId);
  if (call.ringTimer) clearTimeout(call.ringTimer);
  for (const t of call.grace.values()) clearTimeout(t);
  if (userCalls.get(call.callerId) === callId) userCalls.delete(call.callerId);
  if (userCalls.get(call.calleeId) === callId) userCalls.delete(call.calleeId);

  const endedAt = new Date();
  const duration = call.startedAt ? Math.max(0, Math.round((endedAt.getTime() - call.startedAt.getTime()) / 1000)) : 0;

  emitToUser([call.callerId, call.calleeId], 'call:ended', { callId, status, duration });

  try {
    await Call.updateOne({ _id: callId }, { status, endedAt, duration });
    await recordCallMessage(call.conversationId, call.callerId, callId, call.callType, status, duration);
    if (status === 'missed') {
      void notify(call.calleeId, {
        type: 'missed_call',
        title: 'Missed call',
        body: `Missed ${call.callType} call from ${call.callerInfo.displayName}`,
        data: { conversationId: call.conversationId, callId, userId: call.callerId },
      });
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[calls] finalize failed', err);
  }
}

async function recordCallMessage(conversationId: string, callerId: string, callId: string, callType: 'audio' | 'video', status: string, duration: number) {
  const msg = await Message.create({
    conversationId,
    senderId: callerId,
    messageType: 'call',
    content: '',
    call: { callId: new Types.ObjectId(callId), callType, status, duration },
  });
  await Conversation.updateOne(
    { _id: conversationId },
    { $set: { lastMessage: msg._id, lastMessageAt: msg.createdAt, 'memberMeta.$[m].lastReadAt': msg.createdAt } },
    { arrayFilters: [{ 'm.user': new Types.ObjectId(callerId) }] },
  );
  const populated = await Message.findById(msg._id).populate(MESSAGE_POPULATE).lean();
  emitToConversation(conversationId, 'message:new', serializeMessage(populated));
}

function counterpartSocket(call: ActiveCall, socketId: string): string | null {
  if (socketId === call.callerSocket) return call.calleeSocket;
  if (socketId === call.calleeSocket) return call.callerSocket;
  return null;
}

/** Re-sends ringing calls to a device that just connected (e.g. app opened from a push). */
export function resendPendingCalls(socket: Socket) {
  const userId: string = socket.data.userId;
  const callId = userCalls.get(userId);
  const call = callId ? calls.get(callId) : undefined;
  if (call && call.status === 'ringing' && call.calleeId === userId) {
    socket.emit('call:incoming', {
      callId: call.id,
      callType: call.callType,
      conversationId: call.conversationId,
      caller: call.callerInfo,
    });
  }
}

export function registerCallHandlers(io: Server, socket: Socket) {
  const userId: string = socket.data.userId;

  socket.on('call:initiate', async (raw, ackFn) => {
    const ack = safeAck(ackFn);
    try {
      const { calleeId, callType } = initiateSchema.parse(raw);
      if (calleeId === userId) throw ApiError.badRequest("You can't call yourself");
      if (userCalls.has(userId)) throw ApiError.conflict('You are already in a call');
      if (!(await areFriends(userId, calleeId))) throw ApiError.forbidden('You can only call friends');
      if (await isBlockedEitherWay(userId, calleeId)) throw ApiError.forbidden("You can't call this user");
      const calleeSettings = await getSettings(calleeId);
      if (calleeSettings.privacy.calls === 'nobody') throw ApiError.forbidden("This user isn't accepting calls");

      const existingConv = await Conversation.findOne({ privateKey: privateKeyFor(userId, calleeId) }).select('_id').lean();
      const conversationId = existingConv ? String(existingConv._id) : (await getOrCreatePrivate(userId, calleeId)).id;
      const me = await User.findById(userId).select('username displayName avatar').lean();
      const callerInfo = { id: userId, username: me!.username, displayName: me!.displayName, avatarUrl: fileUrl(me!.avatar, 'public') };

      if (userCalls.has(calleeId)) {
        const busy = await Call.create({
          callerId: userId,
          receiverId: calleeId,
          conversationId,
          callType,
          status: 'busy',
          endedAt: new Date(),
          participants: [{ user: userId }, { user: calleeId }],
        });
        await recordCallMessage(conversationId, userId, String(busy._id), callType, 'busy', 0);
        return ack({ ok: false, code: 'busy', error: 'User is on another call' });
      }

      const doc = await Call.create({
        callerId: userId,
        receiverId: calleeId,
        conversationId,
        callType,
        status: 'ringing',
        participants: [{ user: userId, joinedAt: new Date() }, { user: calleeId }],
      });
      const callId = String(doc._id);
      const call: ActiveCall = {
        id: callId,
        callerId: userId,
        calleeId,
        callType,
        conversationId,
        status: 'ringing',
        callerSocket: socket.id,
        calleeSocket: null,
        startedAt: null,
        grace: new Map(),
        callerInfo,
      };
      call.ringTimer = setTimeout(() => void finalizeCall(callId, 'missed'), RING_TIMEOUT_MS);
      calls.set(callId, call);
      userCalls.set(userId, callId);
      userCalls.set(calleeId, callId);

      emitToUser(calleeId, 'call:incoming', { callId, callType, conversationId, caller: callerInfo });
      void notify(
        calleeId,
        {
          type: 'incoming_call',
          title: `Incoming ${callType} call`,
          body: `${callerInfo.displayName} is calling you`,
          data: { callId, callType, conversationId, userId },
        },
        { socket: false },
      );
      ack({ ok: true, callId, conversationId, iceServers: getIceServers(userId) });
    } catch (err) {
      ack({ ok: false, error: err instanceof ApiError ? err.message : 'Could not start the call' });
    }
  });

  socket.on('call:accept', async (raw, ackFn) => {
    const ack = safeAck(ackFn);
    const parsed = callIdSchema.safeParse(raw);
    const call = parsed.success ? calls.get(parsed.data.callId) : undefined;
    if (!call || call.calleeId !== userId) return ack({ ok: false, error: 'Call not found' });
    if (call.status !== 'ringing') return ack({ ok: false, error: 'Call was already answered' });
    if (call.ringTimer) clearTimeout(call.ringTimer);
    call.status = 'ongoing';
    call.calleeSocket = socket.id;
    call.startedAt = new Date();
    await Call.updateOne(
      { _id: call.id, 'participants.user': new Types.ObjectId(userId) },
      { status: 'ongoing', startedAt: call.startedAt, $set: { 'participants.$.joinedAt': call.startedAt } },
    ).catch(() => undefined);
    io.to(call.callerSocket).emit('call:accepted', { callId: call.id });
    socket.to(userRoom(userId)).emit('call:answered-elsewhere', { callId: call.id });
    ack({ ok: true, callId: call.id, iceServers: getIceServers(userId) });
  });

  socket.on('call:reject', async (raw, ackFn) => {
    const ack = safeAck(ackFn);
    const parsed = callIdSchema.safeParse(raw);
    const call = parsed.success ? calls.get(parsed.data.callId) : undefined;
    if (!call || call.calleeId !== userId || call.status !== 'ringing') return ack({ ok: false });
    await finalizeCall(call.id, 'rejected');
    ack({ ok: true });
  });

  socket.on('call:cancel', async (raw, ackFn) => {
    const ack = safeAck(ackFn);
    const parsed = callIdSchema.safeParse(raw);
    const call = parsed.success ? calls.get(parsed.data.callId) : undefined;
    if (!call || call.callerId !== userId) return ack({ ok: false });
    await finalizeCall(call.id, call.status === 'ringing' ? 'missed' : 'ended');
    ack({ ok: true });
  });

  socket.on('call:end', async (raw, ackFn) => {
    const ack = safeAck(ackFn);
    const parsed = callIdSchema.safeParse(raw);
    const call = parsed.success ? calls.get(parsed.data.callId) : undefined;
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return ack({ ok: false });
    let status: CallStatus = 'ended';
    if (call.status === 'ringing') status = call.callerId === userId ? 'missed' : 'rejected';
    await finalizeCall(call.id, status);
    ack({ ok: true });
  });

  socket.on('call:signal', (raw) => {
    const parsed = signalSchema.safeParse(raw);
    if (!parsed.success) return;
    if (Buffer.byteLength(JSON.stringify(parsed.data.payload)) > MAX_SIGNAL_BYTES) return;
    const call = calls.get(parsed.data.callId);
    if (!call || call.status !== 'ongoing') return;
    const target = counterpartSocket(call, socket.id);
    if (target) io.to(target).emit('call:signal', { callId: call.id, payload: parsed.data.payload });
  });

  /** Re-attach a reconnected socket to an ongoing/ringing call within the grace period. */
  socket.on('call:rejoin', (raw, ackFn) => {
    const ack = safeAck(ackFn);
    const parsed = callIdSchema.safeParse(raw);
    const call = parsed.success ? calls.get(parsed.data.callId) : undefined;
    if (!call || (call.callerId !== userId && call.calleeId !== userId)) return ack({ ok: false, error: 'Call has ended' });
    const role = call.callerId === userId ? 'caller' : 'callee';
    if (role === 'callee' && call.status === 'ringing') return ack({ ok: false, error: 'Call not answered' });
    const timer = call.grace.get(userId);
    if (timer) clearTimeout(timer);
    call.grace.delete(userId);
    if (role === 'caller') call.callerSocket = socket.id;
    else call.calleeSocket = socket.id;
    const other = role === 'caller' ? call.calleeSocket : call.callerSocket;
    if (call.status === 'ongoing' && other) io.to(other).emit('call:peer-reconnected', { callId: call.id });
    ack({ ok: true, role, status: call.status, iceServers: getIceServers(userId) });
  });
}

/** Socket disconnected: give the participant a grace period to reconnect before ending the call. */
export function handleCallDisconnect(socket: Socket) {
  const userId: string = socket.data.userId;
  const callId = userCalls.get(userId);
  const call = callId ? calls.get(callId) : undefined;
  if (!call) return;
  const inCall = call.callerSocket === socket.id || call.calleeSocket === socket.id;
  if (!inCall) return;
  const other = counterpartSocket(call, socket.id);
  const io = socket.nsp.server as Server;
  if (other) io.to(other).emit('call:peer-disconnected', { callId: call.id });
  call.grace.set(
    userId,
    setTimeout(() => {
      const status: CallStatus = call.status === 'ongoing' ? 'ended' : 'missed';
      void finalizeCall(call.id, status);
    }, RECONNECT_GRACE_MS),
  );
}
