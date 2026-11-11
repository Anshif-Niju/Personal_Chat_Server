import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, getAuth } from '../middleware/auth';
import { validate, idParam } from '../middleware/validate';
import { asyncHandler } from '../utils/errors';
import { deleteMessage, editMessage, setPinned, toggleReaction } from '../services/messages';

const router = Router();
router.use(requireAuth);

router.patch(
  '/:id',
  validate({ params: idParam, body: z.object({ content: z.string().max(4000) }) }),
  asyncHandler(async (req, res) => {
    res.json({ message: await editMessage(getAuth(req).userId, req.params.id, req.body.content) });
  }),
);

router.delete(
  '/:id',
  validate({ params: idParam, query: z.object({ scope: z.enum(['me', 'everyone']).default('me') }) }),
  asyncHandler(async (req, res) => {
    await deleteMessage(getAuth(req).userId, req.params.id, req.query.scope as 'me' | 'everyone');
    res.json({ ok: true });
  }),
);

router.post(
  '/:id/reactions',
  validate({ params: idParam, body: z.object({ emoji: z.string().min(1).max(16) }) }),
  asyncHandler(async (req, res) => {
    res.json({ reactions: await toggleReaction(getAuth(req).userId, req.params.id, req.body.emoji) });
  }),
);

router.post(
  '/:id/pin',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ pinnedMessageIds: await setPinned(getAuth(req).userId, req.params.id, true) });
  }),
);

router.delete(
  '/:id/pin',
  validate({ params: idParam }),
  asyncHandler(async (req, res) => {
    res.json({ pinnedMessageIds: await setPinned(getAuth(req).userId, req.params.id, false) });
  }),
);

export default router;
