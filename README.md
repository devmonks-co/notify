# @devmonks/notify

Generic notifications for any fetch + WebCrypto runtime (Node 20+, Bun, Workers, Deno). Two steps: **plan** (pure, decides who gets what on which channel) then **send** (one delivery through a channel adapter, one attempt). The app decides when `send` runs (inline, `waitUntil`, a queue) and whether to retry. The core has no database, no queue, no env vars and no dependencies.

| Entry | What | Needs |
| --- | --- | --- |
| `@devmonks/notify` | notifier, FCM push, in-app, quiet hours | nothing |
| `@devmonks/notify/email` | Resend adapter, React Email layout and templates | `react`, `react-dom`, `@react-email/components`, `@react-email/render` |
| `@devmonks/notify/drizzle` | Postgres tables and a store | `drizzle-orm` |

The extra entries are optional peer dependencies: install them only if you import that entry. `/email` contains `.tsx`, so it needs `"jsx": "react-jsx"` in your tsconfig.

## Use it in a new project (push only)

1. `bun add @devmonks/notify` (or npm/pnpm). It ships compiled ESM with types and needs Node 20+ (or Bun, Workers, Deno).
2. In Firebase console: Project settings, Service accounts, Generate new private key. Pass `project_id`, `client_email` and `private_key` from that JSON to `fcmPush` (from your own config; the package reads no env vars).
3. Send and classify:

```ts
import { createNotifier, defineNotification, fcmPush } from '@devmonks/notify';

const priceAlert = defineNotification<{ symbol: string; price: string; alertId: string }>({
  type: 'alert.price',
  category: 'alerts', // the preference key; use the type name for per-type switches
  channels: ['push'],
  // transactional: true -> always send: ignores preferences and quiet hours
  render: (d) => ({
    title: `${d.symbol} hit ${d.price}`,
    body: 'Tap to open the alert.',
    url: `/alerts/${d.alertId}`, // sent as data.url for tap navigation
    data: { alertId: d.alertId },
    push: { badge: 1, collapseKey: `alert-${d.alertId}` },
  }),
});

const notifier = createNotifier({
  channels: [fcmPush({ projectId, clientEmail, privateKey, defaults: { channelId: 'alerts' } })],
  types: [priceAlert],
});

// recipient comes from your own tables
const recipient = { id: user.id, locale: 'en', timeZone: 'UTC', devices: [{ id: device.id, token: device.fcmToken }], prefs: {} };
const deliveries = notifier.plan('alert.price', recipient, data, { dedupeKey: alertEventId });

for (const d of deliveries) {
  // d.idempotencyKey is stable for the same event + recipient + channel + token: use it as your queue job id
  const r = await notifier.send(d); // never throws
  if (r.ok) continue;
  if (r.deadAddress) await deleteDevice(d.deviceId); // token is gone for good
  else if (r.retryable) throw new Error(r.error);    // let your queue retry (429, 5xx, network)
  // else: permanent failure (bad payload, wrong credentials): log r.error, do not retry
}
```

`Delivery` is plain JSON, so you can enqueue it and call `notifier.send(d)` in the worker.

## Plan rules

- `prefs[category][channel] === false` switches a channel off; anything else is on.
- Preferences are per category. Give each type its own category for per-type switches.
- `transactional` types ignore prefs and quiet hours.
- Quiet hours (`{ from: 'HH:MM', to: 'HH:MM' }`, recipient time zone, may cross midnight) drop push and sms; in-app and email stay.
- Push fans out one delivery per `recipient.devices[]` entry (`delivery.deviceId` is set, `delivery.to` is the token).
- Channels with no address (no email, no devices) or no registered adapter are skipped.
- `idempotencyKey = hash(type, recipient.id, channel, to, dedupeKey)`. Pass an event id as `dedupeKey` for anything repeatable; omitting it means "once ever".

## Adapters

| Channel | Adapters |
| --- | --- |
| push | `fcmPush({ projectId, clientEmail, privateKey, defaults?, fetch? })` FCM HTTP v1 (iOS through FCM's apns block), RS256 JWT via WebCrypto, access token cached. `logPush(logger)` |
| inApp | `inApp(write)` where `write(recipientId, content, ctx)` is yours |
| sms | `logSms(logger)` only (implement `Channel` for a provider) |
| email (`/email`) | `resendEmail({ apiKey, from, brand?, linkBase?, fetch? })`, `logEmail(logger)` |

A channel is `{ name, send(to, content, ctx) }`; write your own for any other provider.

### Push options

`PushOptions` go in `fcmPush({ defaults })` for every message and in `content.push` per message (per field, the message wins).

| Option | Android | iOS (apns) |
| --- | --- | --- |
| `channelId` | `notification.channel_id` (create the channel in the app; high importance = heads-up banner) | |
| `priority` `'high'` (default) / `'normal'` | `priority` HIGH / NORMAL | `apns-priority` 10 / 5 |
| `badge` | `notification.notification_count` | `aps.badge` |
| `sound` | `notification.sound` (below Android 8) | `aps.sound`, "default" when unset |
| `threadId` | `notification.tag` | `aps.thread-id` |
| `ttlSeconds` | `ttl` | `apns-expiration` (web: `TTL` header) |
| `collapseKey` | `collapse_key` | `apns-collapse-id` |
| `dataOnly` | no `notification`; `title` and `body` are added to `data` | background push (`content-available`) |
| `raw: { android, apns, webpush }` | deep-merged over the generated message, for any other FCM field | |

`content.data` is sent as FCM `data` (strings only) with `content.url` added as `data.url`.

Results: `{ ok: true, providerId? }` or `{ ok: false, retryable, error, deadAddress? }`. `deadAddress` is set for UNREGISTERED and for INVALID_ARGUMENT that names the token. 401 (except THIRD_PARTY_AUTH_ERROR), 429, 5xx, network errors and UNAVAILABLE / INTERNAL / QUOTA_EXCEEDED are `retryable`. Everything else is permanent. Resend: 429, 5xx and network errors are `retryable`.

## Email (optional, `@devmonks/notify/email`)

Uses React Email. With no `content.email.template`, `simpleEmail({ heading, body, code?, button? })` is built from `title`, `body` and `url`. Custom templates are `(props) => ReactElement`; the adapter passes `brand` in with your `props`. Wrap them in `BaseLayout` (brand slot: `name`, `accent`, `logoUrl`, `footer`, `supportEmail`). `renderEmail(el)` returns `{ html, text }`.

## Using with Drizzle (optional, `@devmonks/notify/drizzle`)

The core never imports this. It ships the tables and a store so each app does not rewrite them. Table names are fixed (`notification`, `notify_device`, `notification_pref`, `notification_settings`, `notification_delivery`). The user id columns take the type of your `users.id` (`uuid` or `text`), so the foreign keys line up. If your schema needs something else, skip this entry and write your own store; `store.ts` shows what the notifier needs (a `Recipient` to plan with, a unique idempotency key, device cleanup from the send result).

```ts
// schema.ts
import { notifyTables } from '@devmonks/notify/drizzle';
export const { notifications, devices, notificationPrefs, notificationSettings, notificationDeliveries } =
  notifyTables({ users }); // your users table, for the foreign keys
// then run your own `drizzle-kit generate`

// runtime
import { drizzleStore } from '@devmonks/notify/drizzle';
const store = drizzleStore(db, { notifications, devices, notificationPrefs, notificationSettings, notificationDeliveries }, {
  getUser: async (id) => ({ email, locale, timeZone }),       // email etc. live in your tables
  defaultPrefs: { reads: { email: false } },                  // optional
  devices: { pruneInactiveAfterDays: null },                  // default null = never prune
});
```

Store methods: `loadRecipient` / `loadRecipients(ids)` (batch, for fan-out), `writeInbox` (the inApp write; returns the new row id, or null when `(type, sourceId, user)` already exists), `recordDelivery` (false if the idempotency key exists: do not send), `finishDelivery`, `touchDevice` (upsert by device id; a token seen under another device id moves), `handleDeviceResult` (device cleanup from a send result), `pruneDevices` and `pruneHistory(days)`.

Devices: one row per install (`id` is stable, the token may rotate). A dead address (`deadAddress`) deletes the device at once; any other permanent failure adds a strike and the device is deleted at 3; a success resets the count; retryable failures change nothing. `pruneDevices()` removes devices unseen for `pruneInactiveAfterDays` and does nothing while that is null.

## Tests

`bun run test` covers the plan rules, the FCM message mapping, the Resend/FCM error mapping with mocked fetch, and that the core entry imports no package.

## Release

1. Bump `version` in `package.json` and commit.
2. `git tag v<version> && git push origin main --tags`.

The `Release` workflow runs typecheck, tests and the build (`prepublishOnly`), then publishes to npm through trusted publishing, with provenance. No npm token or 2FA code is needed.

## Licence

MIT
