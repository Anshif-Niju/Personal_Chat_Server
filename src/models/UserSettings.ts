import { Schema, model, Types } from 'mongoose';

export type Visibility = 'everyone' | 'friends' | 'nobody';

export interface IUserSettings {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  privacy: {
    lastSeen: Visibility;
    onlineStatus: Visibility;
    friendRequests: 'everyone' | 'nobody';
    calls: 'friends' | 'nobody';
    readReceipts: boolean;
  };
  notifications: {
    messages: boolean;
    groups: boolean;
    calls: boolean;
    friendRequests: boolean;
    showPreview: boolean;
    sound: boolean;
  };
  theme: 'light' | 'dark' | 'system';
}

const visibility = { type: String, enum: ['everyone', 'friends', 'nobody'], default: 'friends' };

const settingsSchema = new Schema<IUserSettings>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
    privacy: {
      lastSeen: visibility,
      onlineStatus: visibility,
      friendRequests: { type: String, enum: ['everyone', 'nobody'], default: 'everyone' },
      calls: { type: String, enum: ['friends', 'nobody'], default: 'friends' },
      readReceipts: { type: Boolean, default: true },
    },
    notifications: {
      messages: { type: Boolean, default: true },
      groups: { type: Boolean, default: true },
      calls: { type: Boolean, default: true },
      friendRequests: { type: Boolean, default: true },
      showPreview: { type: Boolean, default: true },
      sound: { type: Boolean, default: true },
    },
    theme: { type: String, enum: ['light', 'dark', 'system'], default: 'system' },
  },
  { timestamps: true },
);

export const UserSettings = model<IUserSettings>('UserSettings', settingsSchema);

/** Returns settings for a user, creating defaults if missing. */
export async function getSettings(userId: Types.ObjectId | string) {
  const existing = await UserSettings.findOne({ userId }).lean();
  if (existing) return existing;
  const created = await UserSettings.findOneAndUpdate(
    { userId },
    { $setOnInsert: { userId } },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  ).lean();
  return created!;
}

export async function getSettingsMap(userIds: (Types.ObjectId | string)[]) {
  const list = await UserSettings.find({ userId: { $in: userIds } }).lean();
  const map = new Map<string, IUserSettings>();
  for (const s of list) map.set(String(s.userId), s);
  return map;
}
