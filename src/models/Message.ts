import { Schema, model, Types, HydratedDocument } from 'mongoose';

export const MESSAGE_TYPES = ['text', 'image', 'video', 'audio', 'voice', 'file', 'system', 'call'] as const;
export type MessageType = (typeof MESSAGE_TYPES)[number];

export interface Attachment {
  key: string;
  provider: 'local' | 'cloudinary';
  resourceType?: string;
  name: string;
  mimeType: string;
  size: number;
  width?: number;
  height?: number;
  duration?: number;
}

export interface IMessage {
  _id: Types.ObjectId;
  conversationId: Types.ObjectId;
  senderId?: Types.ObjectId | null;
  messageType: MessageType;
  content: string;
  attachment?: Attachment | null;
  replyTo?: Types.ObjectId | null;
  forwarded: boolean;
  reactions: { user: Types.ObjectId; emoji: string }[];
  deliveredTo: { user: Types.ObjectId; at: Date }[];
  readBy: { user: Types.ObjectId; at: Date }[];
  editedAt?: Date | null;
  deletedAt?: Date | null;
  deletedFor: Types.ObjectId[];
  clientId?: string;
  call?: { callId: Types.ObjectId; callType: 'audio' | 'video'; status: string; duration: number } | null;
  system?: { action: string; actor?: Types.ObjectId; targets?: Types.ObjectId[]; value?: string } | null;
  createdAt: Date;
  updatedAt: Date;
}

const attachmentSchema = new Schema<Attachment>(
  {
    key: { type: String, required: true },
    provider: { type: String, enum: ['local', 'cloudinary'], required: true },
    resourceType: String,
    name: { type: String, required: true },
    mimeType: { type: String, required: true },
    size: { type: Number, required: true },
    width: Number,
    height: Number,
    duration: Number,
  },
  { _id: false },
);

const receiptSchema = new Schema(
  { user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, at: { type: Date, default: Date.now } },
  { _id: false },
);

const messageSchema = new Schema<IMessage>(
  {
    conversationId: { type: Schema.Types.ObjectId, ref: 'Conversation', required: true },
    senderId: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    messageType: { type: String, enum: MESSAGE_TYPES, default: 'text' },
    content: { type: String, default: '', maxlength: 4000 },
    attachment: { type: attachmentSchema, default: null },
    replyTo: { type: Schema.Types.ObjectId, ref: 'Message', default: null },
    forwarded: { type: Boolean, default: false },
    reactions: [
      new Schema(
        { user: { type: Schema.Types.ObjectId, ref: 'User', required: true }, emoji: { type: String, required: true, maxlength: 16 } },
        { _id: false },
      ),
    ],
    deliveredTo: [receiptSchema],
    readBy: [receiptSchema],
    editedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    deletedFor: [{ type: Schema.Types.ObjectId, ref: 'User' }],
    clientId: { type: String, maxlength: 64 },
    call: {
      type: new Schema(
        {
          callId: { type: Schema.Types.ObjectId, ref: 'Call' },
          callType: { type: String, enum: ['audio', 'video'] },
          status: String,
          duration: { type: Number, default: 0 },
        },
        { _id: false },
      ),
      default: null,
    },
    system: {
      type: new Schema(
        {
          action: String,
          actor: { type: Schema.Types.ObjectId, ref: 'User' },
          targets: [{ type: Schema.Types.ObjectId, ref: 'User' }],
          value: String,
        },
        { _id: false },
      ),
      default: null,
    },
  },
  { timestamps: true },
);

messageSchema.index({ conversationId: 1, createdAt: -1 });
messageSchema.index({ conversationId: 1, messageType: 1, createdAt: -1 });
messageSchema.index({ senderId: 1, clientId: 1 }, { unique: true, partialFilterExpression: { clientId: { $type: 'string' } } });
messageSchema.index({ content: 'text' });

export type MessageDoc = HydratedDocument<IMessage>;
export const Message = model<IMessage>('Message', messageSchema);
