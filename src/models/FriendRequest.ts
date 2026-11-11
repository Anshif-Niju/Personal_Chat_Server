import { Schema, model, Types } from 'mongoose';

export interface IFriendRequest {
  _id: Types.ObjectId;
  senderId: Types.ObjectId;
  receiverId: Types.ObjectId;
  status: 'pending' | 'accepted' | 'rejected';
  pairKey: string;
  respondedAt?: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * One document per pair of users. Its status represents the relationship:
 * pending → accepted (friends) | rejected. Removing a friend deletes the document.
 */
const friendRequestSchema = new Schema<IFriendRequest>(
  {
    senderId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    status: { type: String, enum: ['pending', 'accepted', 'rejected'], default: 'pending' },
    pairKey: { type: String, required: true, unique: true },
    respondedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

friendRequestSchema.index({ receiverId: 1, status: 1 });
friendRequestSchema.index({ senderId: 1, status: 1 });

export const pairKeyFor = (a: string, b: string) => [a, b].sort().join(':');

export const FriendRequest = model<IFriendRequest>('FriendRequest', friendRequestSchema);
