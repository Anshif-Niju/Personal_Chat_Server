import { Router } from 'express';
import path from 'path';
import fs from 'fs';
import { requireAuth, getAuth } from '../middleware/auth';
import { attachmentUpload } from '../middleware/upload';
import { uploadLimiter } from '../middleware/security';
import { asyncHandler, ApiError } from '../utils/errors';
import { classifyUpload, fileUrl, safeFileName, storage } from '../services/storage';
import { LOCAL_UPLOAD_ROOT } from '../services/storage/local';
import { signPayload, verifyPayload } from '../utils/tokens';
import type { Attachment, MessageType } from '../models/Message';
import type { UploadTokenPayload } from '../services/messages';

const router = Router();
const UPLOAD_TOKEN_TTL = 24 * 60 * 60;
const FILE_KEY = /^[a-f0-9]{32}(\.[a-z0-9]+)?$/;

/**
 * Upload an attachment. Returns an HMAC-signed upload token that must be passed
 * to `message:send` — this proves the sender actually uploaded the file.
 * Optional form fields: kind=voice, duration, width, height (client-provided metadata).
 */
router.post(
  '/upload',
  requireAuth,
  uploadLimiter,
  attachmentUpload.single('file'),
  asyncHandler(async (req, res) => {
    const { userId } = getAuth(req);
    const file = req.file;
    if (!file) throw ApiError.badRequest('No file uploaded');
    const category = classifyUpload(file.mimetype, file.originalname);
    if (!category) throw ApiError.badRequest('This file type is not allowed');

    const uploaded = await storage.upload(file.buffer, {
      mimeType: file.mimetype,
      originalName: file.originalname,
      visibility: 'private',
      folder: 'attachments',
    });

    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : undefined;
    };
    const attachment: Attachment = {
      key: uploaded.key,
      provider: uploaded.provider,
      resourceType: uploaded.resourceType,
      name: safeFileName(file.originalname),
      mimeType: file.mimetype.split(';')[0],
      size: file.size,
      width: uploaded.width ?? num(req.body?.width),
      height: uploaded.height ?? num(req.body?.height),
      duration: uploaded.duration ?? num(req.body?.duration),
    };

    let messageType: MessageType;
    if (category === 'image') messageType = 'image';
    else if (category === 'video') messageType = 'video';
    else if (category === 'audio') messageType = req.body?.kind === 'voice' ? 'voice' : 'audio';
    else messageType = 'file';

    const payload: UploadTokenPayload = { uid: userId, mt: messageType, a: attachment };
    res.status(201).json({
      uploadToken: signPayload(payload, UPLOAD_TOKEN_TTL),
      messageType,
      attachment: {
        url: fileUrl(attachment, 'private'),
        name: attachment.name,
        mimeType: attachment.mimeType,
        size: attachment.size,
        width: attachment.width ?? null,
        height: attachment.height ?? null,
        duration: attachment.duration ?? null,
      },
    });
  }),
);

// ---------- Local driver file serving (development) ----------

router.get('/public/:key', (req, res) => {
  const key = String(req.params.key);
  if (!FILE_KEY.test(key)) return res.status(404).end();
  const full = path.join(LOCAL_UPLOAD_ROOT, 'public', key);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendFile(full);
});

router.get('/private/:key', (req, res) => {
  const key = String(req.params.key);
  const data = verifyPayload<{ k: string }>(String(req.query.t ?? ''));
  if (!FILE_KEY.test(key) || !data || data.k !== key) return res.status(403).end();
  const full = path.join(LOCAL_UPLOAD_ROOT, 'private', key);
  if (!fs.existsSync(full)) return res.status(404).end();
  const ext = path.extname(key).toLowerCase();
  const inline = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.m4v', '.mov', '.webm', '.mp3', '.m4a', '.aac', '.ogg', '.oga', '.opus', '.wav', '.weba', '.pdf'];
  if (!inline.includes(ext)) res.setHeader('Content-Disposition', 'attachment');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  res.sendFile(full);
});

export default router;
