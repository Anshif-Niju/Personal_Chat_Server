import nodemailer, { Transporter } from 'nodemailer';
import { env } from '../config/env';

let transporter: Transporter | null = null;

function getTransporter(): Transporter | null {
  if (!env.SMTP_HOST) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      secure: env.SMTP_PORT === 465,
      auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    });
  }
  return transporter;
}

export async function sendMail(to: string, subject: string, text: string, html?: string) {
  const t = getTransporter();
  if (!t) {
    if (env.isProd) {
      // eslint-disable-next-line no-console
      console.error('[mail] SMTP is not configured; email not sent');
    } else if (!env.isTest) {
      // eslint-disable-next-line no-console
      console.log(`[mail:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
    }
    return;
  }
  await t.sendMail({ from: env.MAIL_FROM, to, subject, text, html });
}

export async function sendPasswordResetEmail(to: string, displayName: string, link: string) {
  const text = `Hi ${displayName},\n\nSomeone requested a password reset for your PrivateChat account.\nOpen this link within 1 hour to choose a new password:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`;
  const html = `<p>Hi ${escapeHtml(displayName)},</p><p>Someone requested a password reset for your PrivateChat account.</p><p><a href="${link}">Choose a new password</a> (valid for 1 hour)</p><p>If you didn't request this, you can ignore this email.</p>`;
  await sendMail(to, 'Reset your Anshif Chat password', text, html);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
