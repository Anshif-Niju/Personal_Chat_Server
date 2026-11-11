import { Schema, model, Types, HydratedDocument } from 'mongoose';
import { StoredFile, storedFileSchema } from './User';

export interface MemberMeta {
  user: Types.ObjectId;
  joinedAt: Date;
  lastReadAt: Date;
  clearedAt?: Date | null;
}

export interface IConversation {
  _id: Types.ObjectId;
  type: 'private' | 'group';
  participants: Types.ObjectId[];
  admins: Types.ObjectId[];
  createdBy: Types.ObjectId;
  groupName?: string;
  groupDescription?: string;
  groupImage?: StoredFile | null;
  privateKey?: string;
  lastMessage?: Types.ObjectId | null;
  lastMessageAt: Date;
  memberMeta: MemberMeta[];
  pinnedMessages: Types.ObjectId[];
  permissions: {
    onlyAdminsCanMessage: boolean;
    onlyAdminsCanEditInfo: boolean;
    onlyAdminsCanAddMembers: boolean;
  };
  createdAt: Date;
  updatedAt: Date;
}

const memberMetaSchema = new Schema<MemberMeta>(
  {
    user: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    joinedAt: { type: Date, default: Date.now },
    lastReadAt: { type: Date, default: Date.now },
    clearedAt: { type: Date, default: null },
  },
  { _id: false },
);

const conversationSchema = new Schema<IConversation>(
  {
    type: { type: String, enum: ['private', 'group'], required: true },
    participants: [{ type: Schema.Types.ObjectId, ref: 'User', required: true }],
    admins: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    createdBy: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    groupName: { type: String, trim: true, maxlength: 80 },
    groupDescription: { type: String, trim: true, maxlength: 500, default: '' },
    groupImage: { type: storedFileSchema, default: null },
    privateKey: { type: String },
    lastMessage: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    lastMessageAt: { type: Date, default: Date.now },
    memberMeta: [memberMetaSchema],
    pinnedMessages: [{ type: Schema.Types.ObjectId, ref: 'Message' }],
    permissions: {
      onlyAdminsCanMessage: { type: Boolean, default: false },
      onlyAdminsCanEditInfo: { type: Boolean, default: false },
      onlyAdminsCanAddMembers: { type: Boolean, default: false },
    },
  },
  { timestamps: true },
);

conversationSchema.index({ participants: 1, lastMessageAt: -1 });
conversationSchema.index({ privateKey: 1 }, { unique: true, partialFilterExpression: { privateKey: { $type: 'string' } } });

export const privateKeyFor = (a: string, b: string) => [a, b].sort().join(':');

export type ConversationDoc = HydratedDocument<IConversation>;
export const Conversation = model<IConversation>('Conversation', conversationSchema);
