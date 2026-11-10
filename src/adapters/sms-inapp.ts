import type { Channel, Content, Logger, SendContext, SendResult } from '../types.js';
import { errorMessage } from '../util.js';

/** Dev only: SMS has no provider yet. Implement `Channel` to add one. */
export function logSms(logger: Logger): Channel {
  return {
    name: 'sms',
    async send(to, content: Content): Promise<SendResult> {
      logger.info(`[sms] to=${to} ${content.sms?.text ?? `${content.title}: ${content.body}`}`);
      return { ok: true };
    },
  };
}

/** In-app inbox: the app supplies the write (usually a DB insert). The address is the recipient id. */
export function inApp(write: (recipientId: string, content: Content, ctx: SendContext) => Promise<void>): Channel {
  return {
    name: 'inApp',
    async send(recipientId, content, ctx): Promise<SendResult> {
      try {
        await write(recipientId, content, ctx ?? {});
        return { ok: true };
      } catch (e) {
        return { ok: false, retryable: true, error: errorMessage(e) };
      }
    },
  };
}
