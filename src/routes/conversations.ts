import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, getAuth } from '../middleware/auth';
import { validate, objectId, idParam } from '../middleware/validate';
import { imageUpload } from '../middleware/upload';
import { uploadLimiter } from '../middleware/security';
import { asyncHandler, ApiError } from '../utils/errors';
import { storage } from '../services/storage';
import {
  addMembers,
  clearHistory,
  createGroup,
  deleteGroup,
  getOrCreatePrivate,
  listConversations,
  loadSerializedConversation,
  removeMemberFromGroup,
  setAdmin,
  setGroupImage,
  updateGroupInfo,
  MAX_GROUP_MEMBERS,
} from '../services/conversations';
import { listMedia, listMessages, listPinned, markConversationRead, searchMessages, sendMessage } from '../services/messages';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    res.json({ conversations: await listConversations(getAuth(req).userId) });
  }),
);

router.post(
  '/private',
  validate({ body: z.object({ userId: objectId }) }),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await getOrCreatePrivate(getAuth(req).userId, req.body.userId) });
  }),
);

const createGroupSchema = z.object({
  name: z.string().trim().min(1, 'Group name is required').max(80),
  description: z.string().trim().max(500).optional(),
  memberIds: z.array(objectId).min(1, 'Add at least one member').max(MAX_GROUP_MEMBERS - 1),
});

router.post(
  '/group',
  validate({ body: createGroupSchema }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ conversation: await createGroup(getAuth(req).userId, req.body) });
  }),
);

router.get(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const conversation = await loadSerializedConversation(req.params.id, getAuth(req).userId);
    if (!conversation) throw ApiError.notFound('Conversation not found');
    res.json({ conversation });
  }),
);

const updateGroupSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  description: z.string().trim().max(500).optional(),
  permissions: z
    .object({
      onlyAdminsCanMessage: z.boolean().optional(),
      onlyAdminsCanEditInfo: z.boolean().optional(),
      onlyAdminsCanAddMembers: z.boolean().optional(),
    })
    .optional(),
});

router.patch(
  '/:id',
  validate({ params: idParam, body: updateGroupSchema }),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await updateGroupInfo(getAuth(req).userId, req.params.id, req.body) });
  }),
);

router.post(
  '/:id/avatar',
  uploadLimiter,
  validate({ params: idParam }),
  imageUpload.single('file'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw ApiError.badRequest('No file uploaded');
    const up = await storage.upload(req.file.buffer, {
      mimeType: req.file.mimetype,
      originalName: req.file.originalname,
      visibility: 'public',
      folder: 'groups',
    });
    res.json({ conversation: await setGroupImage(getAuth(req).userId, req.params.id, { key: up.key, provider: up.provider, resourceType: up.resourceType }) });
  }),
);

router.delete(
  '/:id/avatar',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await setGroupImage(getAuth(req).userId, req.params.id, null) });
  }),
);

router.post(
  '/:id/members',
  validate({ params: idParam, body: z.object({ userIds: z.array(objectId).min(1).max(MAX_GROUP_MEMBERS) }) }),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await addMembers(getAuth(req).userId, req.params.id, req.body.userIds) });
  }),
);

router.delete(
  '/:id/members/:userId',
  validate({ params: z.object({ id: objectId, userId: objectId }) }),
  asyncHandler(async (req, res) => {
    await removeMemberFromGroup(req.params.id, getAuth(req).userId, req.params.userId);
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/leave',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    await removeMemberFromGroup(req.params.id, userId, userId);
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/admins/:userId',
  validate({ params: z.object({ id: objectId, userId: objectId }) }),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await setAdmin(getAuth(req).userId, req.params.id, req.params.userId, true) });
  }),
);

router.delete(
  '/:id/admins/:userId',
  validate({ params: z.object({ id: objectId, userId: objectId }) }),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await setAdmin(getAuth(req).userId, req.params.id, req.params.userId, false) });
  }),
);

/** Group: delete for everyone (admins only). */
router.delete(
  '/:id',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await deleteGroup(getAuth(req).userId, req.params.id);
    res.json({ ok: true });
  }),
);

/** Clear chat history for me only. */
router.post(
  '/:id/clear',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ conversation: await clearHistory(getAuth(req).userId, req.params.id) });
  }),
);

router.post(
  '/:id/read',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    await markConversationRead(getAuth(req).userId, req.params.id);
    res.json({ ok: true });
  }),
);

// ---------- Messages within a conversation ----------

router.get(
  '/:id/messages',
  validate({
    params: idParam,
    query: z.object({ before: z.string().datetime().optional(), limit: z.coerce.number().int().min(1).max(100).default(40) }),
  }),
  asyncHandler(async (req, res) => {
    const { before, limit } = req.query as unknown as { before?: string; limit: number };
    res.json(await listMessages(getAuth(req).userId, req.params.id, { before, limit }));
  }),
);

/** REST alternative to the `message:send` socket event. */
router.post(
  '/:id/messages',
  validate({
    params: idParam,
    body: z.object({
      clientId: z.string().max(64).optional(),
      content: z.string().max(4000).optional(),
      uploadToken: z.string().max(4000).optional(),
      replyTo: objectId.optional(),
      forwardFrom: objectId.optional(),
    }),
  }),
  asyncHandler(async (req, res) => {
    res.status(201).json({ message: await sendMessage(getAuth(req).userId, { ...req.body, conversationId: req.params.id }) });
  }),
);

router.get(
  '/:id/messages/search',
  validate({ params: idParam, query: z.object({ q: z.string().trim().min(1).max(100) }) }),
  asyncHandler(async (req, res) => {
    res.json({ messages: await searchMessages(getAuth(req).userId, req.params.id, String(req.query.q)) });
  }),
);

router.get(
  '/:id/media',
  validate({
    params: idParam,
    query: z.object({ kind: z.enum(['media', 'files', 'audio']).default('media'), before: z.string().datetime().optional() }),
  }),
  asyncHandler(async (req, res) => {
    const { kind, before } = req.query as unknown as { kind: string; before?: string };
    res.json(await listMedia(getAuth(req).userId, req.params.id, kind, before));
  }),
);

router.get(
  '/:id/pins',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ messages: await listPinned(getAuth(req).userId, req.params.id) });
  }),
);

export default router;
