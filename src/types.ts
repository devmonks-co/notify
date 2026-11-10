/** What a notification says, independent of how it is delivered. Channels pick what they need. */
export interface Content {
  title: string;
  body: string;
  /** Where tapping it goes (app route or absolute URL). */
  url?: string;
  /** Extra string data (push payload, inbox row). */
  data?: Record<string, string>;
  /**
   * Used by the email entry (`./email`). `template` is a React Email component there (see EmailTemplate);
   * it is typed loosely here so the core does not depend on react.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  email?: { subject?: string; template?: (props: any) => unknown; props?: unknown };
  /** Per-message push options; they override the adapter's `defaults`. */
  push?: PushOptions;
  sms?: { text?: string };
}

/** Push options, mapped to FCM HTTP v1 fields by `fcmPush`. */
export interface PushOptions {
  /**
   * Send no visible notification: the app gets `data` (with `title` and `body` added to it) and
   * decides what to show. iOS gets a background push (`content-available`).
   */
  dataOnly?: boolean;
  /** App icon badge (iOS `aps.badge`, Android `notification_count`). */
  badge?: number;
  /** iOS plays "default" when unset. Android 8+ takes the sound from the channel. */
  sound?: string;
  /** Groups notifications (iOS `thread-id`); on Android a new one replaces the one with the same tag. */
  threadId?: string;
  /** Android notification channel (`channel_id`). The app must create it; a high-importance channel shows heads-up banners. */
  channelId?: string;
  /** Defaults to "high" (Android `HIGH`, APNs 10). "normal" may be delayed to save battery. */
  priority?: 'high' | 'normal';
  /** How long the provider keeps an undelivered message. 0 = deliver now or drop. Unset = provider default. */
  ttlSeconds?: number;
  /** A newer message with the same key replaces an undelivered or displayed older one (`collapse_key`, `apns-collapse-id`). */
  collapseKey?: string;
  /** Escape hatch: raw FCM `AndroidConfig` / `ApnsConfig` / `WebpushConfig` fields, deep-merged over the generated message. */
  raw?: { android?: Record<string, unknown>; apns?: Record<string, unknown>; webpush?: Record<string, unknown> };
}

export type SendResult =
  | { ok: true; providerId?: string }
  | {
      ok: false;
      /** True when trying again later may work (429, 5xx, network). */
      retryable: boolean;
      error: string;
      /** The address is permanently bad (e.g. an unregistered push token): drop it. */
      deadAddress?: boolean;
    };

/** Per-send context passed to the channel. */
export interface SendContext {
  type?: string;
  /** Stable per logical delivery; adapters forward it to providers that support idempotency. */
  idempotencyKey?: string;
}

export interface Channel {
  name: string;
  send(to: string, content: Content, ctx?: SendContext): Promise<SendResult>;
}

export interface Logger {
  info(message: string, meta?: unknown): void;
}

export interface Recipient {
  id: string;
  /** BCP 47, e.g. "en". */
  locale: string;
  /** IANA time zone; drives quiet hours. */
  timeZone: string;
  email?: string;
  phone?: string;
  /** Push-capable installs. One push delivery per device. */
  devices: { id: string; token: string; platform?: string }[];
  /** Defaults to true. */
  inAppEnabled?: boolean;
  /** prefs[category][channel] === false switches it off; anything else is on. */
  prefs: Record<string, Partial<Record<string, boolean>>>;
  /** Local wall-clock window, may cross midnight (e.g. 22:00 to 07:00). */
  quietHours?: { from: string; to: string };
}

export interface Delivery {
  /** Unique per planned delivery (random). Use `idempotencyKey` for dedupe. */
  id: string;
  type: string;
  channel: string;
  to: string;
  content: Content;
  recipientId: string;
  /** Set for push deliveries: the device the token belongs to. */
  deviceId?: string;
  idempotencyKey: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface NotificationType<D = any> {
  type: string;
  /** Preference key: `recipient.prefs[category][channel]`. Use the type name for per-type switches. */
  category: string;
  channels: string[];
  /** Always send: ignores preferences and quiet hours (sign-in codes, security, moderation notices). */
  transactional?: boolean;
  render(data: D, opts: { locale: string }): Content;
}

export interface PlanOptions {
  /**
   * Identifies the event. Same type + recipient + channel + address + dedupeKey = same idempotencyKey.
   * Omit only for "once ever" notifications; pass an event id for anything repeatable.
   */
  dedupeKey?: string;
  now?: Date;
}
