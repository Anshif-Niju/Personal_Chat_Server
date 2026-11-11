import type { Server as HttpServer } from 'http';
import { Server, Socket } from 'socket.io';
import { z } from 'zod';
import { env } from '../config/env';
import { Conversation } from '../models/Conversation';
import { User } from '../models/User';
import { authenticateToken } from '../middleware/auth';
import { objectId } from '../middleware/validate';
import { ApiError } from '../utils/errors';
import { convRoom, sessionRoom, setIo, userRoom } from '../services/realtime';
import { deliverPending, markConversationRead, markDelivered, sendMessage } from '../services/messages';
import { markOfflineIfLast, markOnline } from './presence';
import { handleCallDisconnect, registerCallHandlers, resendPendingCalls } from './calls';

type Ack = (res: Record<string, unknown>) => void;
const safeAck = (ack: unknown): Ack => (typeof ack === 'function' ? (ack as Ack) : () => undefined);

const sendSchema = z.object({
  conversationId: objectId,
  clientId: z.string().max(64).optional(),
  content: z.string().max(4000).optional(),
  uploadToken: z.string().max(4000).optional(),
  replyTo: objectId.optional(),
  forwardFrom: objectId.optional(),
});

/** Very small per-socket token bucket to stop message flooding. */
function rateLimiter(capacity: number, refillPerSec: number) {
  let tokens = capacity;
  let last = Date.now();
  return () => {
    const now = Date.now();
    tokens = Math.min(capacity, tokens + ((now - last) / 1000) * refillPerSec);
    last = now;
    if (tokens < 1) return false;
    tokens -= 1;
    return true;
  };
}

export function createSocketServer(httpServer: HttpServer): Server {
  const io = new Server(httpServer, {
    cors: { origin: env.clientOrigins, credentials: true },
    pingInterval: 20_000,
    pingTimeout: 20_000,
    maxHttpBufferSize: 1e6,
    connectionStateRecovery: { maxDisconnectionDuration: 2 * 60 * 1000, skipMiddlewares: false },
  });
  setIo(io);

  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth?.token;
      if (typeof token !== 'string' || !token) return next(new Error('unauthorized'));
      const { userId, sessionId } = await authenticateToken(token);
      socket.data.userId = userId;
      socket.data.sessionId = sessionId;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    onConnection(io, socket).catch((err) => {
      if (!env.isTest) console.error('[socket] connection setup failed', err);
      socket.disconnect(true);
    });
  });

  return io;
}

async function onConnection(io: Server, socket: Socket) {
  const userId: string = socket.data.userId;
  const sessionId: string = socket.data.sessionId;

  socket.join([userRoom(userId), sessionRoom(sessionId)]);

  // Handlers are registered synchronously so no early event is dropped.
  const allowMessage = rateLimiter(30, 5);
  const allowTyping = rateLimiter(20, 4);

  socket.on('message:send', async (raw, ackFn) => {
    const ack = safeAck(ackFn);
    if (!allowMessage()) return ack({ ok: false, error: 'You are sending messages too quickly' });
    try {
      const input = sendSchema.parse(raw);
      const message = await sendMessage(userId, input);
      ack({ ok: true, message });
    } catch (err) {
      const message = err instanceof ApiError ? err.message : err instanceof z.ZodError ? 'Invalid message' : 'Message could not be sent';
      if (!(err instanceof ApiError) && !(err instanceof z.ZodError) && !env.isTest) console.error('[socket] message:send', err);
      ack({ ok: false, error: message });
    }
  });

  socket.on('message:delivered', async (raw) => {
    const parsed = z.object({ messageIds: z.array(objectId).max(500) }).safeParse(raw);
    if (parsed.success) await markDelivered(userId, parsed.data.messageIds).catch(() => undefined);
  });

  socket.on('conversation:read', async (raw) => {
    const parsed = z.object({ conversationId: objectId }).safeParse(raw);
    if (parsed.success) await markConversationRead(userId, parsed.data.conversationId).catch(() => undefined);
  });

  socket.on('typing', async (raw) => {
    if (!allowTyping()) return;
    const parsed = z.object({ conversationId: objectId, isTyping: z.boolean() }).safeParse(raw);
    if (!parsed.success) return;
    const room = convRoom(parsed.data.conversationId);
    if (!socket.rooms.has(room)) return; // not a member
    if (!socket.data.displayName) {
      const u = await User.findById(userId).select('displayName').lean();
      socket.data.displayName = u?.displayName ?? 'Someone';
    }
    socket.to(room).emit('typing', {
      conversationId: parsed.data.conversationId,
      userId,
      displayName: socket.data.displayName,
      isTyping: parsed.data.isTyping,
    });
  });

  registerCallHandlers(io, socket);

  socket.on('disconnect', () => {
    handleCallDisconnect(socket);
    void markOfflineIfLast(userId).catch(() => undefined);
  });

  const convIds = await Conversation.find({ participants: userId }).distinct('_id');
  socket.join(convIds.map((id) => convRoom(String(id))));

  await markOnline(userId).catch(() => undefined);
  await deliverPending(userId).catch(() => undefined);
  resendPendingCalls(socket);
  socket.emit('ready', { userId });
}
