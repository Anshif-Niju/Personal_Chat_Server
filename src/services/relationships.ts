import { Types } from 'mongoose';
import { FriendRequest, pairKeyFor } from '../models/FriendRequest';
import { Block } from '../models/Block';

type Id = string | Types.ObjectId;

export async function areFriends(a: Id, b: Id): Promise<boolean> {
  return !!(await FriendRequest.exists({ pairKey: pairKeyFor(String(a), String(b)), status: 'accepted' }));
}

export async function getFriendIds(userId: Id): Promise<string[]> {
  const rows = await FriendRequest.find({ status: 'accepted', $or: [{ senderId: userId }, { receiverId: userId }] })
    .select('senderId receiverId')
    .lean();
  return rows.map((r) => (String(r.senderId) === String(userId) ? String(r.receiverId) : String(r.senderId)));
}

export async function isBlockedEitherWay(a: Id, b: Id): Promise<boolean> {
  return !!(await Block.exists({
    $or: [
      { blocker: a, blocked: b },
      { blocker: b, blocked: a },
    ],
  }));
}

/** Ids the user blocked + ids that blocked the user (hidden from search, etc.). */
export async function getBlockRelations(userId: Id): Promise<{ blockedByMe: Set<string>; blockedMe: Set<string> }> {
  const rows = await Block.find({ $or: [{ blocker: userId }, { blocked: userId }] })
    .select('blocker blocked')
    .lean();
  const blockedByMe = new Set<string>();
  const blockedMe = new Set<string>();
  for (const r of rows) {
    if (String(r.blocker) === String(userId)) blockedByMe.add(String(r.blocked));
    else blockedMe.add(String(r.blocker));
  }
  return { blockedByMe, blockedMe };
}

export type Relationship = 'self' | 'friends' | 'outgoing' | 'incoming' | 'none' | 'blocked';

export async function relationshipBetween(me: Id, other: Id): Promise<{ status: Relationship; requestId?: string }> {
  if (String(me) === String(other)) return { status: 'self' };
  if (await Block.exists({ blocker: me, blocked: other })) return { status: 'blocked' };
  const fr = await FriendRequest.findOne({ pairKey: pairKeyFor(String(me), String(other)) }).lean();
  if (!fr || fr.status === 'rejected') return { status: 'none' };
  if (fr.status === 'accepted') return { status: 'friends', requestId: String(fr._id) };
  return { status: String(fr.senderId) === String(me) ? 'outgoing' : 'incoming', requestId: String(fr._id) };
}
