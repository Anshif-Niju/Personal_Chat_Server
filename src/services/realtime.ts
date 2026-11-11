import type { Server } from 'socket.io';

let io: Server | null = null;

export const setIo = (server: Server | null) => {
  io = server;
};
export const getIo = () => io;

export const userRoom = (userId: string) => `user:${userId}`;
export const convRoom = (conversationId: string) => `conv:${conversationId}`;
export const sessionRoom = (sessionId: string) => `session:${sessionId}`;

export function emitToUser(userId: string | string[], event: string, payload: unknown) {
  if (!io) return;
  const ids = Array.isArray(userId) ? userId : [userId];
  if (ids.length === 0) return;
  io.to(ids.map(String).map(userRoom)).emit(event, payload);
}

export function emitToConversation(conversationId: string, event: string, payload: unknown) {
  io?.to(convRoom(String(conversationId))).emit(event, payload);
}

export function joinConversationRoom(userIds: string[], conversationId: string) {
  if (!io || userIds.length === 0) return;
  io.in(userIds.map(String).map(userRoom)).socketsJoin(convRoom(String(conversationId)));
}

export function leaveConversationRoom(userIds: string[], conversationId: string) {
  if (!io || userIds.length === 0) return;
  io.in(userIds.map(String).map(userRoom)).socketsLeave(convRoom(String(conversationId)));
}

export async function isUserOnline(userId: string): Promise<boolean> {
  if (!io) return false;
  const sockets = await io.in(userRoom(String(userId))).fetchSockets();
  return sockets.length > 0;
}

/** Session ids that currently have at least one connected socket. */
export async function connectedSessionIds(userId: string): Promise<Set<string>> {
  const set = new Set<string>();
  if (!io) return set;
  const sockets = await io.in(userRoom(String(userId))).fetchSockets();
  for (const s of sockets) if (s.data?.sessionId) set.add(String(s.data.sessionId));
  return set;
}

export function revokeSessionSockets(sessionId: string | string[]) {
  if (!io) return;
  const ids = (Array.isArray(sessionId) ? sessionId : [sessionId]).map(String);
  if (ids.length === 0) return;
  const rooms = ids.map(sessionRoom);
  io.to(rooms).emit('session:revoked', {});
  io.in(rooms).disconnectSockets(true);
}
