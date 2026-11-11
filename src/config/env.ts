import 'dotenv/config';
import { z } from 'zod';

const csv = (v: string | undefined) =>
  (v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

const schema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(4000),
  MONGODB_URI: z.string().min(1, 'MONGODB_URI is required'),
  JWT_ACCESS_SECRET: z.string().min(1, 'JWT_ACCESS_SECRET is required'),
  MEDIA_SIGNING_SECRET: z.string().min(1, 'MEDIA_SIGNING_SECRET is required'),
  ACCESS_TOKEN_TTL: z.string().default('15m'),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),
  CLIENT_ORIGINS: z.string().default('http://localhost:5173'),
  PUBLIC_API_URL: z.string().default('http://localhost:4000'),
  WEB_APP_URL: z.string().default('http://localhost:5173'),
  TRUST_PROXY: z.coerce.number().default(1),

  STORAGE_DRIVER: z.enum(['local', 'cloudinary']).default('local'),
  MAX_UPLOAD_MB: z.coerce.number().default(25),
  CLOUDINARY_CLOUD_NAME: z.string().optional(),
  CLOUDINARY_API_KEY: z.string().optional(),
  CLOUDINARY_API_SECRET: z.string().optional(),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  MAIL_FROM: z.string().default('PrivateChat <no-reply@example.com>'),

  STUN_URLS: z.string().default('stun:stun.l.google.com:19302'),
  TURN_URLS: z.string().optional(),
  TURN_USERNAME: z.string().optional(),
  TURN_CREDENTIAL: z.string().optional(),
  TURN_SECRET: z.string().optional(),
  TURN_TTL_SECONDS: z.coerce.number().default(3600),

  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:admin@example.com'),
  EXPO_ACCESS_TOKEN: z.string().optional(),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  // eslint-disable-next-line no-console
  console.error('Invalid environment configuration:\n', parsed.error.flatten().fieldErrors);
  throw new Error('Invalid environment configuration');
}

const raw = parsed.data;

if (raw.STORAGE_DRIVER === 'cloudinary' && !(raw.CLOUDINARY_CLOUD_NAME && raw.CLOUDINARY_API_KEY && raw.CLOUDINARY_API_SECRET)) {
  throw new Error('STORAGE_DRIVER=cloudinary requires CLOUDINARY_CLOUD_NAME, CLOUDINARY_API_KEY and CLOUDINARY_API_SECRET');
}
if (raw.NODE_ENV === 'production' && raw.STORAGE_DRIVER === 'local') {
  // eslint-disable-next-line no-console
  console.warn('[warn] STORAGE_DRIVER=local in production: uploaded files are lost when the instance restarts.');
}

export const env = {
  ...raw,
  isProd: raw.NODE_ENV === 'production',
  isTest: raw.NODE_ENV === 'test',
  clientOrigins: csv(raw.CLIENT_ORIGINS),
  stunUrls: csv(raw.STUN_URLS),
  turnUrls: csv(raw.TURN_URLS),
  maxUploadBytes: raw.MAX_UPLOAD_MB * 1024 * 1024,
  publicApiUrl: raw.PUBLIC_API_URL.replace(/\/$/, ''),
  webAppUrl: raw.WEB_APP_URL.replace(/\/$/, ''),
};
