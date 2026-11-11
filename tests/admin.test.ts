import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, expect, it } from 'vitest';
import request from 'supertest';
import { MongoMemoryServer } from 'mongodb-memory-server';
import { io as ioClient, Socket } from 'socket.io-client';

process.env.ADMIN_USERNAMES = 'boss';

let mongo: MongoMemoryServer;
let server: http.Server;
let baseUrl: string;
let app: import('express').Express;
const sockets: Socket[] = [];
const NATIVE = { 'X-Client-Platform': 'android' };
const pw = 'Password123';

const bearer = (t: string) => ({ Authorization: `Bearer ${t}` });
const reg = (username: string) =>
  request(app).post('/api/auth/register').set(NATIVE).send({ username, password: pw, confirmPassword: pw, displayName: username });
const login = (username: string) => request(app).post('/api/auth/login').set(NATIVE).send({ identifier: username, password: pw });

beforeAll(async () => {
  const { connectDb } = await import('../src/config/db');
  const { createApp } = await import('../src/app');
  const { createSocketServer } = await import('../src/socket');
  mongo = await MongoMemoryServer.create();
  await connectDb(mongo.getUri());
  app = createApp();
  server = http.createServer(app);
  createSocketServer(server);
  await new Promise<void>((r) => server.listen(0, r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  sockets.forEach((s) => s.disconnect());
  await new Promise((r) => server.close(r));
  const { disconnectDb } = await import('../src/config/db');
  await disconnectDb();
  await mongo.stop();
});

it('admin approves sign-ups, sees chats, and hard-deletes a user', async () => {
  // Admin signs up and is approved automatically.
  const boss = await reg('boss');
  expect(boss.status).toBe(201);
  const bossLogin = await login('boss');
  expect(bossLogin.status).toBe(200);
  expect(bossLogin.body.user.isAdmin).toBe(true);
  const adminToken = bossLogin.body.accessToken as string;

  // A normal user is pending and can't log in.
  const r1 = await reg('alice_x');
  expect(r1.status).toBe(202);
  expect(r1.body.pending).toBe(true);
  const blocked = await login('alice_x');
  expect(blocked.status).toBe(403);
  expect(blocked.body.error.message).toMatch(/approval/i);

  // Non-admins can't use the admin API (nobody else has a token yet, so use none).
  expect((await request(app).get('/api/admin/users')).status).toBe(401);

  // Pending list → approve.
  const pending = await request(app).get('/api/admin/users?status=pending').set(bearer(adminToken));
  expect(pending.status).toBe(200);
  expect(pending.body.users.map((u: any) => u.username)).toEqual(['alice_x']);
  const aliceId = pending.body.users[0].id as string;
  expect((await request(app).post(`/api/admin/users/${aliceId}/approve`).set(bearer(adminToken))).status).toBe(200);

  const aliceLogin = await login('alice_x');
  expect(aliceLogin.status).toBe(200);
  // Normal users are forbidden from the admin API.
  expect((await request(app).get('/api/admin/users').set(bearer(aliceLogin.body.accessToken))).status).toBe(403);

  // Approving connected alice with boss: a private chat exists.
  const convs = await request(app).get('/api/admin/conversations').set(bearer(adminToken));
  expect(convs.body.conversations.length).toBe(1);
  const convId = convs.body.conversations[0].id as string;

  // Alice sends a message over a socket; admin can read it.
  const s = ioClient(baseUrl, { auth: { token: aliceLogin.body.accessToken }, transports: ['websocket'], forceNew: true });
  sockets.push(s);
  await new Promise((r) => s.once('ready', r));
  const sent = await new Promise<any>((r) => s.emit('message:send', { conversationId: convId, content: 'secret hello', clientId: 'c1' }, r));
  expect(sent.ok).toBe(true);
  const msgs = await request(app).get(`/api/admin/conversations/${convId}/messages`).set(bearer(adminToken));
  expect(msgs.body.messages.map((m: any) => m.content)).toContain('secret hello');

  // Hard delete alice: gone, can't log in, chat + messages removed.
  expect((await request(app).delete(`/api/admin/users/${aliceId}`).set(bearer(adminToken))).status).toBe(200);
  expect((await login('alice_x')).status).toBe(401);
  const { Message } = await import('../src/models/Message');
  const { Conversation } = await import('../src/models/Conversation');
  expect(await Message.countDocuments({ conversationId: convId })).toBe(0);
  expect(await Conversation.countDocuments({ _id: convId })).toBe(0);

  // Rejecting a pending request removes it entirely.
  await reg('bob_x');
  const p2 = await request(app).get('/api/admin/users?status=pending').set(bearer(adminToken));
  expect((await request(app).post(`/api/admin/users/${p2.body.users[0].id}/reject`).set(bearer(adminToken))).status).toBe(200);
  expect((await request(app).get('/api/admin/users?status=pending').set(bearer(adminToken))).body.users).toEqual([]);

  // Admin accounts can't be deleted through the API.
  const bossId = bossLogin.body.user.id as string;
  expect((await request(app).delete(`/api/admin/users/${bossId}`).set(bearer(adminToken))).status).toBe(400);
});
