import { and, eq, gte, inArray, lt, ne, notExists, or, sql, type SQLWrapper } from 'drizzle-orm';
import type { BatchItem } from 'drizzle-orm/batch';
import { alias, type BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core';

import { buildRecipients, lookupUsers, MAX_DEVICE_FAILURES, type DrizzleStoreOptions } from '../shared/store.js';
import type { Content, Delivery, Recipient, SendResult } from '../types.js';
import type { SqliteTables } from './tables.js';

export type SqliteStoreOptions = DrizzleStoreOptions;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnySqliteDb = BaseSQLiteDatabase<'sync' | 'async', any, any>;

/** A Drizzle query built on the store's `db` and ending in `.returning(...)`, for `atomic`. */
export type AtomicStatement = BatchItem<'sqlite'> & SQLWrapper;

/** Bound parameters per `IN (...)` list. D1 allows 100 per statement; plain SQLite far more. */
const IN_CHUNK = 100;

const chunks = <T>(items: readonly T[], size = IN_CHUNK): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
  typeof (value as PromiseLike<unknown> | null)?.then === 'function';

/**
 * The store for SQLite (better-sqlite3, bun:sqlite, libsql, Durable Objects, ...), with the same methods
 * and semantics as `drizzleStore` from `@devmonks/notify/drizzle`. Writes that must apply all-or-none
 * go through `atomic`, the one override point (see `D1Store`).
 */
export class SqliteStore {
  constructor(
    protected readonly db: AnySqliteDb,
    protected readonly tables: SqliteTables,
    protected readonly opts: SqliteStoreOptions,
  ) {}

  /**
   * Runs [statements] all-or-none, in order, and resolves to the rows each one returned (only their
   * count is portable: the rows may come back unmapped). Each statement must end in `.returning(...)`.
   * The statements are fixed up front: nothing may depend on an earlier one's result.
   *
   * The default re-issues them on a `db.transaction`. Override it where the driver has a better
   * primitive: D1 has no interactive transactions, so `D1Store` uses `db.batch`.
   */
  protected async atomic(statements: readonly AtomicStatement[]): Promise<unknown[][]> {
    if (statements.length === 0) return [];
    // The callback is not async: sync drivers (better-sqlite3) need a sync one, async drivers get a promise chain.
    return await this.db.transaction((tx) => {
      const results: unknown[][] = [];
      const step = (i: number): unknown[][] | PromiseLike<unknown[][]> => {
        for (; i < statements.length; i++) {
          const rows: unknown = tx.all(statements[i]!.getSQL());
          if (isThenable(rows)) {
            const next = i + 1;
            return rows.then((r) => {
              results.push(r as unknown[]);
              return step(next);
            });
          }
          results.push(rows as unknown[]);
        }
        return results;
      };
      return step(0) as unknown[][];
    });
  }

  /** Loads everything `notifier.plan` needs. Null when the app does not know the user. */
  async loadRecipient(userId: string): Promise<Recipient | null> {
    return (await this.loadRecipients([userId])).get(userId) ?? null;
  }

  /**
   * `loadRecipient` for many users in four queries (one with `getUsers`), for fan-out batches.
   * Users the app does not know are left out of the map.
   */
  async loadRecipients(userIds: readonly string[]): Promise<Map<string, Recipient>> {
    const { devices, notificationPrefs, notificationSettings } = this.tables;
    const ids = [...new Set(userIds)];
    if (ids.length === 0) return new Map();
    const users = await lookupUsers(this.opts, ids);
    const known = ids.filter((id) => users.has(id));
    if (known.length === 0) return new Map();
    // One query per table and per 100 ids: D1 caps the bound parameters of a statement.
    const each = async <T>(query: (part: string[]) => PromiseLike<T[]>) => (await Promise.all(chunks(known).map(query))).flat();
    const [deviceRows, prefRows, settingRows] = await Promise.all([
      each((part) =>
        this.db
          .select({ userId: devices.userId, id: devices.id, token: devices.token, platform: devices.platform })
          .from(devices)
          .where(inArray(devices.userId, part)),
      ),
      each((part) => this.db.select().from(notificationPrefs).where(inArray(notificationPrefs.userId, part))),
      each((part) => this.db.select().from(notificationSettings).where(inArray(notificationSettings.userId, part))),
    ]);
    return buildRecipients(known, users, { devices: deviceRows, prefs: prefRows, settings: settingRows }, this.opts.defaultPrefs);
  }

  /**
   * The inApp channel's write. With a `sourceId`, a second write for the same type, source and user
   * is ignored. Returns the new row's id (e.g. to put in the push data so a tap can mark it read), or
   * null when nothing was inserted.
   */
  async writeInbox(
    recipientId: string,
    content: Content,
    meta: { type?: string; sourceId?: string; actorId?: string } = {},
  ): Promise<string | null> {
    const { notifications } = this.tables;
    const rows = await this.db
      .insert(notifications)
      .values({
        id: crypto.randomUUID(),
        userId: recipientId,
        type: meta.type ?? 'unknown',
        title: content.title,
        body: content.body,
        url: content.url ?? null,
        data: content.data ?? {},
        sourceId: meta.sourceId ?? null,
        actorId: meta.actorId ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    return rows[0]?.id ?? null;
  }

  /** Inserts a pending delivery row. False when the idempotency key already exists (do not send again). */
  async recordDelivery(d: Delivery): Promise<boolean> {
    const { notificationDeliveries } = this.tables;
    const rows = await this.db
      .insert(notificationDeliveries)
      .values({
        id: d.id,
        idempotencyKey: d.idempotencyKey,
        type: d.type,
        userId: d.recipientId,
        channel: d.channel,
        deviceId: d.deviceId ?? null,
      })
      .onConflictDoNothing({ target: notificationDeliveries.idempotencyKey })
      .returning({ id: notificationDeliveries.id });
    return rows.length > 0;
  }

  async finishDelivery(d: Delivery, status: 'sent' | 'failed' | 'skipped', attempts: number, error?: string): Promise<void> {
    const { notificationDeliveries } = this.tables;
    await this.db
      .update(notificationDeliveries)
      .set({ status, attempts, error: error ?? null })
      .where(eq(notificationDeliveries.id, d.id));
  }

  /**
   * Upserts a device by its install id. A device row that belongs to another user is only taken over
   * when the caller also holds its current push token (same phone, new account); otherwise nothing
   * changes and this returns false, so nobody can hijack a device id they merely know.
   */
  async touchDevice(userId: string, deviceId: string, info: { platform: string; token: string; appVersion?: string }): Promise<boolean> {
    const { devices } = this.tables;
    const appVersion = info.appVersion ?? '';
    // The row at deviceId that blocks a takeover: another user's, and the caller does not hold its token.
    const held = alias(devices, 'held');
    const blocked = this.db
      .select({ id: held.id })
      .from(held)
      .where(and(eq(held.id, deviceId), ne(held.userId, userId), ne(held.token, info.token)));
    const [, upserted] = await this.atomic([
      // A push token lives on one install: drop it from any other device row first (the app was
      // reinstalled). Holding the token is proof enough, and the token column is unique. Skipped when
      // the upsert below will be refused, so a refused call changes nothing (no rollback needed).
      this.db
        .delete(devices)
        .where(and(eq(devices.token, info.token), ne(devices.id, deviceId), notExists(blocked)))
        .returning({ id: devices.id }),
      this.db
        .insert(devices)
        .values({ id: deviceId, userId, platform: info.platform, token: info.token, appVersion })
        .onConflictDoUpdate({
          target: devices.id,
          set: { userId, platform: info.platform, token: info.token, appVersion, lastSeenAt: new Date(), failureCount: 0 },
          setWhere: or(eq(devices.userId, userId), eq(devices.token, info.token)),
        })
        .returning({ id: devices.id }),
    ]);
    return (upserted?.length ?? 0) > 0;
  }

  /**
   * The device bookkeeping for one finished push delivery:
   * success resets failures; a dead address (UNREGISTERED etc.) deletes the device;
   * any other permanent failure counts a strike and deletes it at MAX_DEVICE_FAILURES;
   * retryable failures change nothing. Deletes and strikes apply only while the device
   * still holds the token that was sent to (it may have refreshed since).
   */
  async handleDeviceResult(d: Delivery, result: SendResult): Promise<void> {
    if (!d.deviceId) return;
    const { devices } = this.tables;
    const sameToken = and(eq(devices.id, d.deviceId), eq(devices.token, d.to));
    if (result.ok) {
      await this.db.update(devices).set({ failureCount: 0 }).where(and(eq(devices.id, d.deviceId), ne(devices.failureCount, 0)));
    } else if (result.deadAddress) {
      await this.db.delete(devices).where(sameToken);
    } else if (!result.retryable) {
      await this.atomic([
        this.db
          .update(devices)
          .set({ failureCount: sql`${devices.failureCount} + 1` })
          .where(sameToken)
          .returning({ id: devices.id }),
        this.db
          .delete(devices)
          .where(and(sameToken, gte(devices.failureCount, MAX_DEVICE_FAILURES)))
          .returning({ id: devices.id }),
      ]);
    }
  }

  /**
   * Removes devices whose `lastSeenAt` is older than [olderThanDays] (default: the
   * `devices.pruneInactiveAfterDays` option). Null, undefined or non-positive means never prune.
   * Returns how many were removed.
   */
  async pruneDevices(olderThanDays: number | null | undefined = this.opts.devices?.pruneInactiveAfterDays): Promise<number> {
    if (!olderThanDays || olderThanDays <= 0) return 0;
    const { devices } = this.tables;
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const rows = await this.db.delete(devices).where(lt(devices.lastSeenAt, cutoff)).returning({ id: devices.id });
    return rows.length;
  }

  /** Deletes inbox and delivery rows older than [olderThanDays]. Returns how many of each were removed. */
  async pruneHistory(olderThanDays: number): Promise<{ notifications: number; deliveries: number }> {
    const { notifications, notificationDeliveries } = this.tables;
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
    const [inbox, sent] = await Promise.all([
      this.db.delete(notifications).where(lt(notifications.createdAt, cutoff)).returning({ id: notifications.id }),
      this.db.delete(notificationDeliveries).where(lt(notificationDeliveries.createdAt, cutoff)).returning({ id: notificationDeliveries.id }),
    ]);
    return { notifications: inbox.length, deliveries: sent.length };
  }
}
