import path from 'path';
import { env } from '../../config/env';
import { localDriver } from './local';
import { cloudinaryDriver } from './cloudinary';

export type Visibility = 'public' | 'private';

export interface UploadResult {
  key: string;
  provider: 'local' | 'cloudinary';
  resourceType?: string;
  width?: number;
  height?: number;
  duration?: number;
}

export interface StorageDriver {
  name: 'local' | 'cloudinary';
  upload(buffer: Buffer, opts: { mimeType: string; originalName: string; visibility: Visibility; folder: string }): Promise<UploadResult>;
  url(file: { key: string; resourceType?: string }, visibility: Visibility): string;
  remove(file: { key: string; resourceType?: string }, visibility: Visibility): Promise<void>;
}

const drivers: Record<'local' | 'cloudinary', StorageDriver> = { local: localDriver, cloudinary: cloudinaryDriver };

export const storage = drivers[env.STORAGE_DRIVER];
export const driverFor = (provider: 'local' | 'cloudinary') => drivers[provider];

export function fileUrl(file: { key: string; provider: 'local' | 'cloudinary'; resourceType?: string } | null | undefined, visibility: Visibility) {
  if (!file) return null;
  try {
    return driverFor(file.provider).url(file, visibility);
  } catch {
    return null;
  }
}

// ---------- Upload validation ----------

export type MediaCategory = 'image' | 'video' | 'audio' | 'document';

const ALLOWED: Record<MediaCategory, Record<string, string[]>> = {
  image: {
    'image/jpeg': ['.jpg', '.jpeg'],
    'image/png': ['.png'],
    'image/gif': ['.gif'],
    'image/webp': ['.webp'],
    'image/heic': ['.heic'],
  },
  video: {
    'video/mp4': ['.mp4', '.m4v'],
    'video/quicktime': ['.mov'],
    'video/webm': ['.webm'],
    'video/3gpp': ['.3gp'],
  },
  audio: {
    'audio/mpeg': ['.mp3'],
    'audio/mp4': ['.m4a', '.mp4'],
    'audio/x-m4a': ['.m4a'],
    'audio/aac': ['.aac'],
    'audio/ogg': ['.ogg', '.oga', '.opus'],
    'audio/wav': ['.wav'],
    'audio/x-wav': ['.wav'],
    'audio/webm': ['.webm', '.weba'],
    'audio/3gpp': ['.3gp'],
  },
  document: {
    'application/pdf': ['.pdf'],
    'application/msword': ['.doc'],
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
    'application/vnd.ms-excel': ['.xls'],
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
    'application/vnd.ms-powerpoint': ['.ppt'],
    'application/vnd.openxmlformats-officedocument.presentationml.presentation': ['.pptx'],
    'text/plain': ['.txt'],
    'text/csv': ['.csv'],
    'application/zip': ['.zip'],
    'application/x-zip-compressed': ['.zip'],
  },
};

/** Returns the category if MIME type AND extension are both on the allowlist, else null. */
export function classifyUpload(mimeType: string, originalName: string): MediaCategory | null {
  const ext = path.extname(originalName).toLowerCase();
  const mime = mimeType.split(';')[0].trim().toLowerCase();
  for (const [category, map] of Object.entries(ALLOWED) as [MediaCategory, Record<string, string[]>][]) {
    if (map[mime]?.includes(ext)) return category;
  }
  return null;
}

export function safeFileName(name: string): string {
  const base = path.basename(name).replace(/[^\w.\- ()]/g, '_').slice(0, 120);
  return base || 'file';
}
