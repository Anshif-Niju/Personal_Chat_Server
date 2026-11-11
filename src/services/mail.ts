import { env } from '../config/env';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';

/** Sends a transactional email through Brevo's HTTP API (no SMTP / nodemailer needed). */
export async function sendMail(to: string, subject: string, text: string, html?: string) {
  if (!env.BREVO_API_KEY || !env.MAIL_FROM_EMAIL) {
    if (env.isProd) {
      // eslint-disable-next-line no-console
      console.error('[mail] BREVO_API_KEY / MAIL_FROM_EMAIL not configured; email not sent');
    } else if (!env.isTest) {
      // eslint-disable-next-line no-console
      console.log(`[mail:dev] To: ${to}\nSubject: ${subject}\n${text}\n`);
    }
    return;
  }
  const res = await fetch(BREVO_URL, {
    method: 'POST',
    headers: { 'api-key': env.BREVO_API_KEY, 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      sender: { name: env.MAIL_FROM_NAME, email: env.MAIL_FROM_EMAIL },
      to: [{ email: to }],
      subject,
      textContent: text,
      htmlContent: html,
    }),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    // eslint-disable-next-line no-console
    console.error(`[mail] Brevo rejected the email (${res.status}): ${detail.slice(0, 300)}`);
    throw new Error('Email could not be sent');
  }
}

export async function sendPasswordResetEmail(to: string, displayName: string, link: string) {
  const text = `Hi ${displayName},\n\nSomeone requested a password reset for your M32 Baddies account.\nOpen this link within 1 hour to choose a new password:\n\n${link}\n\nIf you didn't request this, you can ignore this email.`;
  const html = `<p>Hi ${escapeHtml(displayName)},</p><p>Someone requested a password reset for your M32 Baddies account.</p><p><a href="${link}">Choose a new password</a> (valid for 1 hour)</p><p>If you didn't request this, you can ignore this email.</p>`;
  await sendMail(to, 'Reset your M32 Baddies password', text, html);
}

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
