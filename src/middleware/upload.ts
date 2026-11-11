import multer from 'multer';
import { env } from '../config/env';
import { classifyUpload } from '../services/storage';
import { ApiError } from '../utils/errors';

/** Any allowlisted attachment (image, video, audio, document). Stored in memory then streamed to storage. */
export const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.maxUploadBytes, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (!classifyUpload(file.mimetype, file.originalname)) {
      return cb(new ApiError(400, 'This file type is not allowed', 'upload_error'));
    }
    cb(null, true);
  },
});

/** Images only, 5 MB (avatars, group pictures). */
export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => {
    if (classifyUpload(file.mimetype, file.originalname) !== 'image') {
      return cb(new ApiError(400, 'Please upload a JPG, PNG, GIF or WEBP image', 'upload_error'));
    }
    cb(null, true);
  },
});
