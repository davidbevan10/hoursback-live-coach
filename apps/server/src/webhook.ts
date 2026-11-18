import crypto from 'node:crypto';

/** Zoom endpoint.url_validation challenge response. */
export function urlValidation(plainToken: string, secret: string) {
  const encryptedToken = crypto.createHmac('sha256', secret).update(plainToken).digest('hex');
  return { plainToken, encryptedToken };
}

/** Zoom signs v0:{x-zm-request-timestamp}:{raw body} with the secret token. Reject stale timestamps (5 min). */
export function verifySignature(rawBody: string, headers: Record<string, any>, secret: string): boolean {
  const ts = String(headers['x-zm-request-timestamp'] ?? '');
  const sig = String(headers['x-zm-signature'] ?? '');
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const expected = 'v0=' + crypto.createHmac('sha256', secret).update(`v0:${ts}:${rawBody}`).digest('hex');
  const a = Buffer.from(sig), b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
