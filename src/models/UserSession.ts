import { Schema, model, Types } from 'mongoose';

export interface WebPushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface IUserSession {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
  deviceName: string;
  platform: 'web' | 'ios' | 'android' | 'unknown';
  userAgent?: string;
  ip?: string;
  refreshTokenHash: string;
  previousTokenHash?: string | null;
  rotatedAt?: Date | null;
  lastActive: Date;
  expiresAt: Date;
  revokedAt?: Date | null;
  expoPushToken?: string | null;
  webPush?: WebPushSubscription | null;
  createdAt: Date;
}

const sessionSchema = new Schema<IUserSession>(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    deviceName: { type: String, default: 'Unknown device', maxlength: 100 },
    platform: { type: String, enum: ['web', 'ios', 'android', 'unknown'], default: 'unknown' },
    userAgent: String,
    ip: String,
    refreshTokenHash: { type: String, required: true },
    previousTokenHash: { type: String, default: null },
    rotatedAt: { type: Date, default: null },
    lastActive: { type: Date, default: Date.now },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
    expoPushToken: { type: String, default: null },
    webPush: {
      type: new Schema({ endpoint: String, keys: { p256dh: String, auth: String } }, { _id: false }),
      default: null,
    },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

// MongoDB removes expired sessions automatically.
sessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const UserSession = model<IUserSession>('UserSession', sessionSchema);
