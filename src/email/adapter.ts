import type { Channel, Content, Logger, SendResult } from '../types.js';
import { errorMessage, retryableStatus, tryJson } from '../util.js';
import { renderContentEmail } from './render.js';
import type { EmailBrand } from './types.js';

export interface EmailOptions {
  brand?: EmailBrand;
  /** Prefix for relative `content.url` values so the email button works, e.g. "https://example.com". */
  linkBase?: string;
}

export interface ResendOptions extends EmailOptions {
  apiKey: string;
  /** e.g. `Acme <hello@example.com>` */
  from: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

/** Email through the Resend HTTP API (fetch only, Workers-safe). 429 and 5xx are retryable. */
export function resendEmail({ apiKey, from, fetch: f = fetch, brand, linkBase }: ResendOptions): Channel {
  return {
    name: 'email',
    async send(to, content, ctx): Promise<SendResult> {
      let rendered: Awaited<ReturnType<typeof renderContentEmail>>;
      try {
        rendered = await renderContentEmail(content, brand, linkBase);
      } catch (e) {
        return { ok: false, retryable: false, error: `render failed: ${errorMessage(e)}` };
      }
      let res: Response;
      try {
        res = await f('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            ...(ctx?.idempotencyKey ? { 'Idempotency-Key': ctx.idempotencyKey } : {}),
          },
          body: JSON.stringify({ from, to: [to], subject: rendered.subject, html: rendered.html, text: rendered.text }),
        });
      } catch (e) {
        return { ok: false, retryable: true, error: `network: ${errorMessage(e)}` };
      }
      if (res.ok) {
        const json = (await res.json().catch(() => ({}))) as { id?: string };
        return json.id ? { ok: true, providerId: json.id } : { ok: true };
      }
      const raw = await res.text().catch(() => '');
      const j = tryJson<{ name?: string; message?: string }>(raw);
      const reason = [j?.name, j?.message].filter(Boolean).join(': ') || raw.slice(0, 300);
      return { ok: false, retryable: retryableStatus(res.status), error: `resend ${res.status}: ${reason}` };
    },
  };
}

/** Dev: prints the rendered plain-text email instead of sending. */
export function logEmail(logger: Logger, opts: EmailOptions = {}): Channel {
  return {
    name: 'email',
    async send(to, content: Content): Promise<SendResult> {
      const r = await renderContentEmail(content, opts.brand, opts.linkBase);
      logger.info(`[email] to=${to} subject=${JSON.stringify(r.subject)}\n${r.text}`);
      return { ok: true };
    },
  };
}
