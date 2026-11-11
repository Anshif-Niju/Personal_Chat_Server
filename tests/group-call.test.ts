import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, expect, it } from 'vitest';
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
const NATIVE = { 'X-Client-Platform': 'android' };

async function register(username: string) {
  const res = await request(app)
    .post('/api/auth/register')
    .set(NATIVE)
    .send({ username, password: 'Password123', confirmPassword: 'Password123', displayName: username });
  expect(res.status).toBe(202); // pending admin approval
  const user = await User.findOneAndUpdate({ username }, { approved: true }, { new: true });
  await connectNewUser(String(user!._id));
  const login = await request(app).post('/api/auth/login').set(NATIVE).send({ identifier: username, password: 'Password123' });
  expect(login.status).toBe(200);
  return { id: login.body.user.id as string, token: login.body.accessToken as string };
}
function connect(u: { token: string }): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const s = ioClient(baseUrl, { auth: { token: u.token }, transports: ['websocket'], forceNew: true });
    sockets.push(s);
    s.once('ready', () => resolve(s));
    s.once('connect_error', reject);
  });
}
const ack = (s: Socket, ev: string, p: unknown) => new Promise<any>((r) => s.emit(ev, p, r));
const once = (s: Socket, ev: string, pred: (d: any) => boolean = () => true, ms = 4000) =>
  new Promise<any>((res, rej) => {
    const t = setTimeout(() => rej(new Error('timeout ' + ev)), ms);
    const h = (d: any) => {
      if (!pred(d)) return;
      clearTimeout(t);
      s.off(ev, h);
      res(d);
    };
    const s2 = s;
    s2.on(ev, h);
  });

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

it('group call: start rings members, join exchanges peers + signals, last leave ends it', async () => {
  const a = await register('gcall_a');
  const b = await register('gcall_b');
  const c = await register('gcall_c');
  const outsider = await register('gcall_d');
  const group = await request(app).post('/api/conversations/group').set({ Authorization: `Bearer ${a.token}` }).send({ name: 'Team', memberIds: [b.id, c.id] });
  expect(group.status).toBe(201);
  const conversationId = group.body.conversation.id;

  const sa = await connect(a);
  const sb = await connect(b);
  const sc = await connect(c);
  const sd = await connect(outsider);

  const bRings = once(sb, 'gcall:incoming');
  const cRings = once(sc, 'gcall:incoming');
  let outsiderRang = false;
  sd.on('gcall:incoming', () => (outsiderRang = true));

  const started = await ack(sa, 'gcall:start', { conversationId, callType: 'video' });
  expect(started.ok).toBe(true);
  const ring = await bRings;
  await cRings;
  expect(ring.groupName).toBe('Team');
  expect(ring.callType).toBe('video');

  // second start in the same group is refused
  expect((await ack(sb, 'gcall:start', { conversationId, callType: 'audio' })).ok).toBe(false);
  // outsider can't join
  expect((await ack(sd, 'gcall:join', { callId: started.callId })).ok).toBe(false);

  const aSeesB = once(sa, 'gcall:peer-joined', (d) => d.user.id === b.id);
  const joinB = await ack(sb, 'gcall:join', { callId: started.callId });
  expect(joinB.ok).toBe(true);
  expect(joinB.peers.map((p: any) => p.id)).toEqual([a.id]);
  await aSeesB;

  const aSeesC = once(sa, 'gcall:peer-joined', (d) => d.user.id === c.id);
  const bSeesC = once(sb, 'gcall:peer-joined', (d) => d.user.id === c.id);
  const joinC = await ack(sc, 'gcall:join', { callId: started.callId });
  expect(joinC.peers.map((p: any) => p.id).sort()).toEqual([a.id, b.id].sort());
  await aSeesC;
  await bSeesC;

  // signalling is addressed per user
  const bGetsOffer = once(sb, 'gcall:signal');
  sc.emit('gcall:signal', { callId: started.callId, to: b.id, payload: { type: 'offer', sdp: 'x' } });
  const sig = await bGetsOffer;
  expect(sig.from).toBe(c.id);
  expect(sig.payload.type).toBe('offer');

  const aSeesCLeave = once(sa, 'gcall:peer-left', (d) => d.userId === c.id);
  await ack(sc, 'gcall:leave', { callId: started.callId });
  await aSeesCLeave;

  const ended = once(sc, 'gcall:ended');
  await ack(sa, 'gcall:leave', { callId: started.callId });
  await ack(sb, 'gcall:leave', { callId: started.callId });
  expect((await ended).conversationId).toBe(conversationId);
  expect(outsiderRang).toBe(false);
});
