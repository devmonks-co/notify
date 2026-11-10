import { hashParts } from './hash.js';
import { inQuietHours } from './quiet-hours.js';
import type { Channel, Content, Delivery, NotificationType, PlanOptions, Recipient, SendResult } from './types.js';
import { errorMessage } from './util.js';

/** Channels muted during quiet hours. In-app and email are not interruptive. */
const QUIET_MUTED = new Set(['push', 'sms']);

export interface NotifierConfig {
  channels: Channel[];
  types: NotificationType[];
}

export interface Notifier {
  /** Pure: decides who gets what on which channel. Sends nothing. */
  plan<D>(type: string | NotificationType<D>, recipient: Recipient, data: D, opts?: PlanOptions): Delivery[];
  /** Sends ONE delivery through its channel adapter. Never throws. */
  send(delivery: Delivery): Promise<SendResult>;
}

/** Identity: gives `render` its data type. */
export function defineNotification<D>(type: NotificationType<D>): NotificationType<D> {
  return type;
}

interface Address { to: string; deviceId?: string }

function addressesFor(channel: string, r: Recipient): Address[] {
  switch (channel) {
    case 'email':
      return r.email ? [{ to: r.email }] : [];
    case 'sms':
      return r.phone ? [{ to: r.phone }] : [];
    case 'push': {
      const seen = new Set<string>();
      return r.devices.filter((d) => d.token && !seen.has(d.token) && seen.add(d.token)).map((d) => ({ to: d.token, deviceId: d.id }));
    }
    case 'inApp':
      return r.inAppEnabled === false ? [] : [{ to: r.id }];
    default:
      return [{ to: r.id }];
  }
}

export function createNotifier(config: NotifierConfig): Notifier {
  const channels: Record<string, Channel> = Object.fromEntries(config.channels.map((c) => [c.name, c]));
  const types: Record<string, NotificationType> = Object.fromEntries(config.types.map((t) => [t.type, t]));

  return {
    plan(type, recipient, data, opts = {}) {
      const def = typeof type === 'string' ? (Object.hasOwn(types, type) ? types[type] : undefined) : type;
      if (!def) throw new Error(`Unknown notification type: ${String(type)}`);
      const now = opts.now ?? new Date();
      const quiet = !def.transactional && inQuietHours(now, recipient.timeZone, recipient.quietHours);
      const categoryPrefs = Object.hasOwn(recipient.prefs, def.category) ? (recipient.prefs[def.category] ?? {}) : {};

      let content: Content | undefined;
      const out: Delivery[] = [];
      for (const channel of def.channels) {
        if (!channels[channel]) continue;
        if (!def.transactional && categoryPrefs[channel] === false) continue;
        if (quiet && QUIET_MUTED.has(channel)) continue;
        const addresses = addressesFor(channel, recipient);
        if (addresses.length === 0) continue;
        content ??= def.render(data, { locale: recipient.locale });
        for (const { to, deviceId } of addresses) {
          out.push({
            id: crypto.randomUUID(),
            type: def.type,
            channel,
            to,
            content,
            recipientId: recipient.id,
            ...(deviceId ? { deviceId } : {}),
            idempotencyKey: hashParts([def.type, recipient.id, channel, to, opts.dedupeKey]),
          });
        }
      }
      return out;
    },

    async send(delivery) {
      const channel = channels[delivery.channel];
      if (!channel) return { ok: false, retryable: false, error: `No adapter for channel "${delivery.channel}"` };
      try {
        return await channel.send(delivery.to, delivery.content, { type: delivery.type, idempotencyKey: delivery.idempotencyKey });
      } catch (e) {
        return { ok: false, retryable: true, error: errorMessage(e) };
      }
    },
  };
}
