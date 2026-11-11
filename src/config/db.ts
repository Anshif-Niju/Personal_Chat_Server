import mongoose from 'mongoose';
import { env } from './env';

mongoose.set('strictQuery', true);

export async function connectDb(uri = env.MONGODB_URI): Promise<typeof mongoose> {
  const conn = await mongoose.connect(uri, {
    autoIndex: true,
    serverSelectionTimeoutMS: 15000,
  });
  if (!env.isTest) {
    // eslint-disable-next-line no-console
    console.log(`[db] connected to ${conn.connection.host}/${conn.connection.name}`);
  }
  return conn;
}

export async function disconnectDb(): Promise<void> {
  await mongoose.disconnect();
}
