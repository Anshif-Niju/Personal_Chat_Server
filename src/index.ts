import http from 'http';
import { env } from './config/env';
import { connectDb, disconnectDb } from './config/db';
import { createApp } from './app';
import { createSocketServer } from './socket';
import { User } from './models/User';
import { startKeepAlive } from './services/keepAlive';

async function main() {
  await connectDb();
  // Nobody is connected right after a (re)start.
  await User.updateMany({ isOnline: true }, { isOnline: false, lastSeen: new Date() });

  const app = createApp();
  const server = http.createServer(app);
  const io = createSocketServer(server);

  server.listen(env.PORT, () => {
    // eslint-disable-next-line no-console
    console.log(`[server] listening on :${env.PORT} (${env.NODE_ENV})`);
  });

  const stopKeepAlive = startKeepAlive();

  const shutdown = async (signal: string) => {
    // eslint-disable-next-line no-console
    console.log(`[server] ${signal} received, shutting down`);
    stopKeepAlive();
    io.close();
    server.close();
    await disconnectDb();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[server] failed to start', err);
  process.exit(1);
});
