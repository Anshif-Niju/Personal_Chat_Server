import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioClient, Socket } from 'socket.io-client';
import { connectDb, disconnectDb } from '../src/config/db';
import { createApp } from '../src/app';
import { createSocketServer } from '../src/socket';
import { User } from '../src/models/User';
import { connectNewUser } from '../src/services/conversations';

let mongo: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
const app = createApp();
const sockets: Socket[] = [];

interface TestUser {
  id: string;
  username: string;
  accessToken: string;
  refreshToken: string;
}

const NATIVE = { 'X-Client-Platform': 'android', 'X-Device-Name': 'Test phone' };

async function register(username: string, password = 'Password123'): Promise<TestUser> {
  const res = await request(app)
    .post('/api/auth/register')
    .set(NATIVE)
    .send({ username, password, confirmPassword: password, displayName: username.toUpperCase() });
  // New accounts wait for admin approval: approve directly, then log in like a normal user.
  expect(res.status).toBe(202);
  const user = await User.findOneAndUpdate({ username }, { approved: true }, { new: true });
  await connectNewUser(String(user!._id));
  const login = await request(app).post('/api/auth/login').set(NATIVE).send({ identifier: username, password });
  expect(login.status).toBe(200);
  return { id: login.body.user.id, username, accessToken: login.body.accessToken, refreshToken: login.body.refreshToken };
}

const auth = (u: TestUser) => ({ Authorization: `Bearer ${u.accessToken}` });

function connect(u: TestUser): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth: { token: u.accessToken }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.once('ready', () => resolve(s));
    s.once('connect_error', reject);
  });
}

function waitFor<T = any>(s: Socket, event: string, predicate: (d: T) => boolean = () => true, ms = 5000): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    const handler = (d: T) => {
      if (!predicate(d)) return;
      clearTimeout(timer);
      s.off(event, handler);
      resolve(d);
    };
    s.on(event, handler);
  });
}

function emitAck<T = any>(s: Socket, event: string, payload: unknown): Promise<T> {
  return new Promise((resolve) => s.emit(event, payload, resolve));
}

async function makeFriends(a: TestUser, b: TestUser) {
  const req1 = await request(app).post('/api/friends/requests').set(auth(a)).send({ userId: b.id });
  // New users are auto-friended with everyone on registration, so the pair may already be friends.
  if (req1.status === 409) return;
  expect(req1.status).toBe(201);
  const acc = await request(app).post(`/api/friends/requests/${req1.body.requestId}/accept`).set(auth(b));
  expect(acc.status).toBe(200);
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  server = http.createServer(app);
  createSocketServer(server);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await new Promise((r) => server.close(r));
  await disconnectDb();
  await mongo.stop();
});

describe('authentication (no phone number)', () => {
  it('registers with username + password only, rejects duplicates and weak passwords', async () => {
    await register('alice');
    const dup = await request(app)
      .post('/api/auth/register')
      .send({ username: 'ALICE', password: 'Password123', confirmPassword: 'Password123', displayName: 'x' });
    expect(dup.status).toBe(409);
    const weak = await request(app).post('/api/auth/register').send({ username: 'weakling', password: 'short', confirmPassword: 'short', displayName: 'x' });
    expect(weak.status).toBe(400);
    const mismatch = await request(app)
      .post('/api/auth/register')
      .send({ username: 'mismatch', password: 'Password123', confirmPassword: 'Password124', displayName: 'x' });
    expect(mismatch.status).toBe(400);
  });

  it('logs in by username, rotates refresh tokens and detects reuse', async () => {
    const login = await request(app).post('/api/auth/login').set(NATIVE).send({ identifier: '@Alice', password: 'Password123' });
    expect(login.status).toBe(200);
    const bad = await request(app).post('/api/auth/login').send({ identifier: 'alice', password: 'wrong-pass1' });
    expect(bad.status).toBe(401);

    const r1 = await request(app).post('/api/auth/refresh').set(NATIVE).send({ refreshToken: login.body.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);

    const r2 = await request(app).post('/api/auth/refresh').set(NATIVE).send({ refreshToken: r1.body.refreshToken });
    expect(r2.status).toBe(200);
    // r1 token is now "previous" (within grace) → still ok; original login token is two rotations old → reuse.
    const reuse = await request(app).post('/api/auth/refresh').set(NATIVE).send({ refreshToken: login.body.refreshToken });
    expect(reuse.status).toBe(401);
    // Session was revoked → the newest token no longer works either.
    const after = await request(app).post('/api/auth/refresh').set(NATIVE).send({ refreshToken: r2.body.refreshToken });
    expect(after.status).toBe(401);
  });

  it('web clients receive the refresh token as an httpOnly cookie', async () => {
    const res = await request(app).post('/api/auth/login').set('X-Client-Platform', 'web').send({ identifier: 'alice', password: 'Password123' });
    expect(res.status).toBe(200);
    expect(res.body.refreshToken).toBeUndefined();
    const cookie = String(res.headers['set-cookie']);
    expect(cookie).toContain('pc_rt=');
    expect(cookie).toContain('HttpOnly');
  });

  it('protects routes', async () => {
    expect((await request(app).get('/api/conversations')).status).toBe(401);
  });
});

describe('friends, private messaging, receipts and isolation', () => {
  let a: TestUser;
  let b: TestUser;
  let c: TestUser;
  let conversationId: string;

  beforeAll(async () => {
    a = await register('user_a');
    b = await register('user_b');
    c = await register('user_c');
  });

  it('A finds B by username and they become friends; emails are never exposed', async () => {
    const search = await request(app).get('/api/users/search?q=user_b').set(auth(a));
    expect(search.status).toBe(200);
    expect(search.body.users.map((u: any) => u.username)).toContain('user_b');
    expect(search.body.users[0].email).toBeUndefined();

    await makeFriends(a, b);
    const friends = await request(app).get('/api/friends').set(auth(a));
    expect(friends.body.friends.map((f: any) => f.id)).toContain(b.id);
  });

  it('delivers messages instantly with delivered + read receipts', async () => {
    const conv = await request(app).post('/api/conversations/private').set(auth(a)).send({ userId: b.id });
    expect(conv.status).toBe(200);
    conversationId = conv.body.conversation.id;

    const sa = await connect(a);
    const sb = await connect(b);

    const incoming = waitFor(sb, 'message:new', (m: any) => m.content === 'hello B');
    const ack = await emitAck(sa, 'message:send', { conversationId, clientId: 'c1', content: 'hello B' });
    expect(ack.ok).toBe(true);
    const msg = await incoming;
    expect(msg.sender.id).toBe(a.id);

    // Idempotent resend with the same clientId.
    const again = await emitAck(sa, 'message:send', { conversationId, clientId: 'c1', content: 'hello B' });
    expect(again.message.id).toBe(ack.message.id);

    const delivered = waitFor(sa, 'message:receipt', (r: any) => r.kind === 'delivered');
    sb.emit('message:delivered', { messageIds: [msg.id] });
    expect((await delivered).messageIds).toContain(msg.id);

    const unread = await request(app).get('/api/conversations').set(auth(b));
    expect(unread.body.conversations[0].unreadCount).toBe(1);

    const read = waitFor(sa, 'message:receipt', (r: any) => r.kind === 'read');
    sb.emit('conversation:read', { conversationId });
    expect((await read).userId).toBe(b.id);

    const after = await request(app).get('/api/conversations').set(auth(b));
    expect(after.body.conversations[0].unreadCount).toBe(0);
  });

  it('supports typing, reply, edit, reactions, pin, search and delete', async () => {
    const sa = await connect(a);
    const sb = await connect(b);
    const typing = waitFor(sb, 'typing', (t: any) => t.userId === a.id && t.isTyping);
    sa.emit('typing', { conversationId, isTyping: true });
    await typing;

    const first = await emitAck(sb, 'message:send', { conversationId, content: 'pizza tonight?' });
    const reply = await emitAck(sa, 'message:send', { conversationId, content: 'yes!', replyTo: first.message.id });
    expect(reply.message.replyTo.id).toBe(first.message.id);

    const edit = await request(app).patch(`/api/messages/${reply.message.id}`).set(auth(a)).send({ content: 'yes please!' });
    expect(edit.body.message.editedAt).toBeTruthy();
    const notMine = await request(app).patch(`/api/messages/${reply.message.id}`).set(auth(b)).send({ content: 'hacked' });
    expect(notMine.status).toBe(403);

    const react = await request(app).post(`/api/messages/${first.message.id}/reactions`).set(auth(a)).send({ emoji: '👍' });
    expect(react.body.reactions).toEqual([{ userId: a.id, emoji: '👍' }]);

    const pin = await request(app).post(`/api/messages/${first.message.id}/pin`).set(auth(a));
    expect(pin.body.pinnedMessageIds).toContain(first.message.id);

    const search = await request(app).get(`/api/conversations/${conversationId}/messages/search?q=PIZZA`).set(auth(b));
    expect(search.body.messages).toHaveLength(1);

    const del = await request(app).delete(`/api/messages/${reply.message.id}?scope=everyone`).set(auth(a));
    expect(del.status).toBe(200);
    const history = await request(app).get(`/api/conversations/${conversationId}/messages`).set(auth(b));
    const deleted = history.body.messages.find((m: any) => m.id === reply.message.id);
    expect(deleted.isDeleted).toBe(true);
    expect(deleted.content).toBe('');
  });

  it('keeps history after logout/login', async () => {
    const login = await request(app).post('/api/auth/login').set(NATIVE).send({ identifier: 'user_b', password: 'Password123' });
    const history = await request(app)
      .get(`/api/conversations/${conversationId}/messages`)
      .set({ Authorization: `Bearer ${login.body.accessToken}` });
    expect(history.status).toBe(200);
    expect(history.body.messages.some((m: any) => m.content === 'hello B')).toBe(true);
  });

  it("prevents other users from accessing a private conversation", async () => {
    expect((await request(app).get(`/api/conversations/${conversationId}`).set(auth(c))).status).toBe(404);
    expect((await request(app).get(`/api/conversations/${conversationId}/messages`).set(auth(c))).status).toBe(404);
    const sc = await connect(c);
    const res = await emitAck(sc, 'message:send', { conversationId, content: 'intrusion' });
    expect(res.ok).toBe(false);
    const msgId = (await request(app).get(`/api/conversations/${conversationId}/messages`).set(auth(a))).body.messages[0].id;
    expect((await request(app).post(`/api/messages/${msgId}/reactions`).set(auth(c)).send({ emoji: '😈' })).status).toBe(404);
  });

  it('blocks messaging after a block', async () => {
    await request(app).post(`/api/users/${a.id}/block`).set(auth(b)).expect(200);
    const res = await request(app).post(`/api/conversations/${conversationId}/messages`).set(auth(a)).send({ content: 'hi?' });
    expect(res.status).toBe(403);
    await request(app).delete(`/api/users/${a.id}/block`).set(auth(b)).expect(200);
    await makeFriends(a, b);
  });

  it('uploads an image and sends it as an attachment', async () => {
    // 1x1 transparent PNG
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
    const up = await request(app).post('/api/media/upload').set(auth(a)).attach('file', png, { filename: 'dot.png', contentType: 'image/png' });
    expect(up.status).toBe(201);
    const bad = await request(app)
      .post('/api/media/upload')
      .set(auth(a))
      .attach('file', Buffer.from('<script>'), { filename: 'evil.html', contentType: 'text/html' });
    expect(bad.status).toBe(400);

    const sent = await request(app).post(`/api/conversations/${conversationId}/messages`).set(auth(a)).send({ uploadToken: up.body.uploadToken });
    expect(sent.status).toBe(201);
    expect(sent.body.message.messageType).toBe('image');
    // Another user cannot reuse A's upload token.
    const stolen = await request(app).post(`/api/conversations/${conversationId}/messages`).set(auth(b)).send({ uploadToken: up.body.uploadToken });
    expect(stolen.status).toBe(400);

    const url = new URL(sent.body.message.attachment.url);
    const file = await request(app).get(url.pathname + url.search);
    expect(file.status).toBe(200);
    expect((await request(app).get(url.pathname)).status).toBe(403);
  });

  it('runs a full call signalling flow and records call history', async () => {
    const sa = await connect(a);
    const sb = await connect(b);
    const incoming = waitFor(sb, 'call:incoming');
    const init = await emitAck(sa, 'call:initiate', { calleeId: b.id, callType: 'video' });
    expect(init.ok).toBe(true);
    expect(Array.isArray(init.iceServers)).toBe(true);
    expect((await incoming).caller.id).toBe(a.id);

    const accepted = waitFor(sa, 'call:accepted');
    expect((await emitAck(sb, 'call:accept', { callId: init.callId })).ok).toBe(true);
    await accepted;

    const offer = waitFor(sb, 'call:signal', (d: any) => d.payload.type === 'offer');
    sa.emit('call:signal', { callId: init.callId, payload: { type: 'offer', sdp: 'v=0...' } });
    expect((await offer).payload.sdp).toBe('v=0...');

    const endedB = waitFor(sb, 'call:ended');
    await emitAck(sa, 'call:end', { callId: init.callId });
    expect((await endedB).status).toBe('ended');

    const history = await request(app).get('/api/calls').set(auth(b));
    expect(history.body.calls[0]).toMatchObject({ direction: 'incoming', callType: 'video', status: 'ended' });
  });

  it('creates a group chat and delivers group messages', async () => {
    await makeFriends(a, c);
    const group = await request(app).post('/api/conversations/group').set(auth(a)).send({ name: 'Team', memberIds: [b.id, c.id] });
    expect(group.status).toBe(201);
    const gid = group.body.conversation.id;
    const sc = await connect(c);
    const sa = await connect(a);
    const got = waitFor(sc, 'message:new', (m: any) => m.content === 'hi team');
    await emitAck(sa, 'message:send', { conversationId: gid, content: 'hi team' });
    await got;

    // Non-admin cannot remove members; admin can.
    expect((await request(app).delete(`/api/conversations/${gid}/members/${b.id}`).set(auth(c))).status).toBe(403);
    expect((await request(app).delete(`/api/conversations/${gid}/members/${b.id}`).set(auth(a))).status).toBe(200);
    expect((await request(app).get(`/api/conversations/${gid}/messages`).set(auth(b))).status).toBe(404);
  });
});
