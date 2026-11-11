import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { env } from '../../config/env';
import { signPayload } from '../../utils/tokens';
import type { StorageDriver } from './index';

/** Development driver: stores files on local disk, private files are served with signed, expiring URLs. */
export const LOCAL_UPLOAD_ROOT = path.resolve(process.cwd(), 'uploads');
const PRIVATE_URL_TTL = 6 * 60 * 60; // 6 hours

export const localDriver: StorageDriver = {
  name: 'local',

  async upload(buffer, { originalName, visibility }) {
    const dir = path.join(LOCAL_UPLOAD_ROOT, visibility);
    await fs.mkdir(dir, { recursive: true });
    const ext = path.extname(originalName).toLowerCase().replace(/[^.a-z0-9]/g, '');
    const fileName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
    await fs.writeFile(path.join(dir, fileName), buffer);
    return { key: fileName, provider: 'local' };
  },

  url(file, visibility) {
    if (visibility === 'public') return `${env.publicApiUrl}/api/media/public/${file.key}`;
    const t = signPayload({ k: file.key }, PRIVATE_URL_TTL);
    return `${env.publicApiUrl}/api/media/private/${file.key}?t=${t}`;
  },

  async remove(file, visibility) {
    if (!/^[a-f0-9]{32}(\.[a-z0-9]+)?$/.test(file.key)) return;
    await fs.unlink(path.join(LOCAL_UPLOAD_ROOT, visibility, file.key)).catch(() => undefined);
  },
};
