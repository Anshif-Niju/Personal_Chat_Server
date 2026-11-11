import crypto from 'crypto';
import path from 'path';
import { v2 as cloudinary, UploadApiResponse } from 'cloudinary';
import { env } from '../../config/env';
import type { StorageDriver } from './index';

let configured = false;
function ensureConfigured() {
  if (configured) return;
  cloudinary.config({
    cloud_name: env.CLOUDINARY_CLOUD_NAME,
    api_key: env.CLOUDINARY_API_KEY,
    api_secret: env.CLOUDINARY_API_SECRET,
    secure: true,
  });
  configured = true;
}

/**
 * Production driver.
 * - public files (avatars, group images): delivery type "upload"
 * - private files (message attachments): delivery type "authenticated" → only signed URLs work
 */
export const cloudinaryDriver: StorageDriver = {
  name: 'cloudinary',

  upload(buffer, { mimeType, originalName, visibility, folder }) {
    ensureConfigured();
    const isRaw = !/^(image|video|audio)\//.test(mimeType);
    return new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        {
          folder: `privatechat/${folder}`,
          resource_type: isRaw ? 'raw' : 'auto',
          type: visibility === 'private' ? 'authenticated' : 'upload',
          // raw (document) files keep their extension in the public id so downloads open correctly
          ...(isRaw ? { public_id: `${crypto.randomBytes(16).toString('hex')}${path.extname(originalName).toLowerCase()}` } : {}),
        },
        (err, result?: UploadApiResponse) => {
          if (err || !result) return reject(err ?? new Error('Upload failed'));
          resolve({
            key: result.public_id,
            provider: 'cloudinary',
            resourceType: result.resource_type,
            width: result.width,
            height: result.height,
            duration: typeof result.duration === 'number' ? result.duration : undefined,
          });
        },
      );
      stream.end(buffer);
    });
  },

  url(file, visibility) {
    ensureConfigured();
    return cloudinary.url(file.key, {
      resource_type: file.resourceType ?? 'image',
      type: visibility === 'private' ? 'authenticated' : 'upload',
      sign_url: visibility === 'private',
      secure: true,
    });
  },

  async remove(file, visibility) {
    ensureConfigured();
    await cloudinary.uploader
      .destroy(file.key, { resource_type: file.resourceType ?? 'image', type: visibility === 'private' ? 'authenticated' : 'upload', invalidate: true })
      .catch(() => undefined);
  },
};
