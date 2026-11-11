import { Schema, model, Types, HydratedDocument } from 'mongoose';

export interface StoredFile {
  key: string;
  provider: 'local' | 'cloudinary';
  resourceType?: string;
}

export interface IUser {
  _id: Types.ObjectId;
  username: string;
  email?: string;
  passwordHash: string;
  displayName: string;
  avatar?: StoredFile | null;
  bio: string;
  isOnline: boolean;
  lastSeen: Date;
  passwordChangedAt?: Date;
  resetTokenHash?: string | null;
  resetTokenExpires?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export const USERNAME_REGEX = /^[a-z0-9_.]{3,30}$/;

export const storedFileSchema = new Schema<StoredFile>(
  {
    key: { type: String, required: true },
    provider: { type: String, enum: ['local', 'cloudinary'], required: true },
    resourceType: String,
  },
  { _id: false },
);

const userSchema = new Schema<IUser>(
  {
    username: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      match: USERNAME_REGEX,
    },
    email: { type: String, lowercase: true, trim: true },
    passwordHash: { type: String, required: true, select: false },
    displayName: { type: String, required: true, trim: true, maxlength: 50 },
    avatar: { type: storedFileSchema, default: null },
    bio: { type: String, default: '', maxlength: 250 },
    isOnline: { type: Boolean, default: false },
    lastSeen: { type: Date, default: Date.now },
    passwordChangedAt: Date,
    resetTokenHash: { type: String, select: false, default: null },
    resetTokenExpires: { type: Date, select: false, default: null },
  },
  { timestamps: true },
);

userSchema.index({ email: 1 }, { unique: true, partialFilterExpression: { email: { $type: 'string' } } });
userSchema.index({ username: 'text', displayName: 'text' });
userSchema.index({ resetTokenHash: 1 }, { sparse: true });

export type UserDoc = HydratedDocument<IUser>;
export const User = model<IUser>('User', userSchema);
