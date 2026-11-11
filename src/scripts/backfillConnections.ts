import { connectDb, disconnectDb } from '../config/db';
import { env } from '../config/env';
import { User } from '../models/User';
import { connectNewUser } from '../services/conversations';

/** One-off: friends + private chats between every pair of existing users. */
async function main() {
  await connectDb(env.MONGODB_URI);
  const users = await User.find().select('_id username').lean();
  for (const u of users) {
    await connectNewUser(String(u._id));
    console.log('connected', u.username);
  }
  await disconnectDb();
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  },
);
