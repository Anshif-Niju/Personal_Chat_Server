import { Schema, model, Types } from 'mongoose';

export type CallStatus = 'ringing' | 'ongoing' | 'ended' | 'missed' | 'rejected' | 'cancelled' | 'busy' | 'failed';

export interface ICall {
  _id: Types.ObjectId;
  callerId: Types.ObjectId;
  receiverId: Types.ObjectId;
  conversationId: Types.ObjectId;
  callType: 'audio' | 'video';
  status: CallStatus;
  /** Reserved for future group calls (SFU). */
  participants: { user: Types.ObjectId; joinedAt?: Date; leftAt?: Date }[];
  startedAt?: Date | null;
  endedAt?: Date | null;
  duration: number;
  createdAt: Date;
}

const callSchema = new Schema<ICall>(
  {
    callerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    receiverId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    callType: { type: String, enum: ['audio', 'video'], required: true },
    status: {
      type: String,
      enum: ['ringing', 'ongoing', 'ended', 'missed', 'rejected', 'cancelled', 'busy', 'failed'],
      default: 'ringing',
    },
    participants: [
      new Schema({ user: { type: Schema.Types.ObjectId, ref: 'User' }, joinedAt: Date, leftAt: Date }, { _id: false }),
    ],
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    duration: { type: Number, default: 0 },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);

callSchema.index({ callerId: 1, createdAt: -1 });
callSchema.index({ receiverId: 1, createdAt: -1 });

export const Call = model<ICall>('Call', callSchema);
