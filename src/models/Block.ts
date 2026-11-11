import { Schema, model, Types } from 'mongoose';

export interface IBlock {
  _id: Types.ObjectId;
  blocker: Types.ObjectId;
  blocked: Types.ObjectId;
  createdAt: Date;
}

const blockSchema = new Schema<IBlock>(
  {
    blocker: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    blocked: { type: Schema.Types.ObjectId, ref: 'User', required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
blockSchema.index({ blocker: 1, blocked: 1 }, { unique: true });
blockSchema.index({ blocked: 1 });

export const Block = model<IBlock>('Block', blockSchema);

export interface IReport {
  _id: Types.ObjectId;
  reporter: Types.ObjectId;
  reported: Types.ObjectId;
  reason: string;
  details?: string;
  conversationId?: Types.ObjectId;
  messageId?: Types.ObjectId;
  status: 'open' | 'reviewed' | 'dismissed';
  createdAt: Date;
}

const reportSchema = new Schema<IReport>(
  {
    reporter: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reported: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    reason: { type: String, enum: ['spam', 'harassment', 'impersonation', 'inappropriate', 'other'], required: true },
    details: { type: String, maxlength: 1000 },
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation' },
    messageId: { type: Schema.Types.ObjectId, ref: 'Message' },
    status: { type: String, enum: ['open', 'reviewed', 'dismissed'], default: 'open' },
  },
  { timestamps: { createdAt: true, updatedAt: false } },
);
reportSchema.index({ status: 1, createdAt: -1 });

export const Report = model<IReport>('Report', reportSchema);
