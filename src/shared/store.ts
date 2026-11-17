// What the Postgres (`./drizzle`) and SQLite (`./sqlite`, `./d1`) stores share. No database imports here.
import type { Recipient } from '../types.js';

/** Devices are deleted after this many consecutive permanent failures. */
export const MAX_DEVICE_FAILURES = 3;

export interface UserInfo {
  email?: string | null;
  locale?: string | null;
  timeZone?: string | null;
}

export interface DrizzleStoreOptions {
  /** The app's user lookup: email, locale and time zone live in the app's own tables. */
  getUser(id: string): Promise<UserInfo | null>;
  /** Optional batch form of `getUser` for `loadRecipients`; without it, `getUser` runs per id. */
  getUsers?(ids: readonly string[]): Promise<ReadonlyMap<string, UserInfo>>;
  /** Preference defaults when a user has no row, e.g. `{ reads: { email: false } }`. */
  defaultPrefs?: Record<string, Partial<Record<string, boolean>>>;
  devices?: {
    /** Delete devices not seen for this many days when `pruneDevices()` runs. null/undefined = never prune (default). */
    pruneInactiveAfterDays?: number | null;
  };
}

/** The app's users for [ids], through `getUsers` when given, else `getUser` per id. Unknown ids are left out. */
export async function lookupUsers(opts: DrizzleStoreOptions, ids: readonly string[]): Promise<ReadonlyMap<string, UserInfo>> {
  if (opts.getUsers) return opts.getUsers(ids);
  const entries = await Promise.all(ids.map(async (id) => [id, await opts.getUser(id)] as const));
  return new Map(entries.filter((e): e is [string, UserInfo] => e[1] !== null));
}

export interface RecipientRows {
  devices: readonly { userId: string; id: string; token: string; platform: string }[];
  prefs: readonly { userId: string; category: string; channel: string; enabled: boolean }[];
  settings: readonly { userId: string; quietFrom: string | null; quietTo: string | null }[];
}

/** Builds the `Recipient` map from the user lookup and the store's rows. */
export function buildRecipients(
  known: readonly string[],
  users: ReadonlyMap<string, UserInfo>,
  rows: RecipientRows,
  defaultPrefs: DrizzleStoreOptions['defaultPrefs'],
): Map<string, Recipient> {
  const recipients = new Map<string, Recipient>();
  for (const id of known) {
    const user = users.get(id)!;
    // Null-prototype maps: category and channel are stored strings, so "__proto__" must stay a plain key.
    const prefs: Recipient['prefs'] = Object.create(null);
    for (const [cat, chans] of Object.entries(defaultPrefs ?? {})) prefs[cat] = Object.assign(Object.create(null), chans);
    for (const p of rows.prefs) if (p.userId === id) (prefs[p.category] ??= Object.create(null))[p.channel] = p.enabled;
    const settings = rows.settings.find((row) => row.userId === id);
    recipients.set(id, {
      id,
      locale: user.locale || 'en',
      timeZone: user.timeZone || 'UTC',
      ...(user.email ? { email: user.email } : {}),
      devices: rows.devices.filter((d) => d.userId === id).map(({ id: deviceId, token, platform }) => ({ id: deviceId, token, platform })),
      prefs,
      ...(settings?.quietFrom && settings.quietTo ? { quietHours: { from: settings.quietFrom, to: settings.quietTo } } : {}),
    });
  }
  return recipients;
}
