import { and, eq, inArray, lt, ne, notExists, or, sql } from 'drizzle-orm';
import { alias, type PgDatabase } from 'drizzle-orm/pg-core';

import { buildRecipients, lookupUsers, MAX_DEVICE_FAILURES, type DrizzleStoreOptions } from '../shared/store.js';
import type { Content, Delivery, Recipient, SendResult } from '../types.js';
import type { NotifyTables } from './tables.js';

export { MAX_DEVICE_FAILURES, type DrizzleStoreOptions, type UserInfo } from '../shared/store.js';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyPgDb = PgDatabase<any, any, any>;

export function drizzleStore(db: AnyPgDb, tables: NotifyTables, opts: DrizzleStoreOptions) {
  const { notifications, devices, notificationPrefs, notificationSettings, notificationDeliveries } = tables;

  return {
    /** Loads everything `notifier.plan` needs. Null when the app does not know the user. */
    async loadRecipient(userId: string): Promise<Recipient | null> {
      return (await this.loadRecipients([userId])).get(userId) ?? null;
    },

    /**
     * `loadRecipient` for many users in four queries (one with `getUsers`), for fan-out batches.
     * Users the app does not know are left out of the map.
     */
    async loadRecipients(userIds: readonly string[]): Promise<Map<string, Recipient>> {
      const ids = [...new Set(userIds)];
      if (ids.length === 0) return new Map();
      const users = await lookupUsers(opts, ids);
      const known = ids.filter((id) => users.has(id));
      if (known.length === 0) return new Map();
      const [deviceRows, prefRows, settingRows] = await Promise.all([
        db.select({ userId: devices.userId, id: devices.id, token: devices.token, platform: devices.platform }).from(devices).where(inArray(devices.userId, known)),
        db.select().from(notificationPrefs).where(inArray(notificationPrefs.userId, known)),
        db.select().from(notificationSettings).where(inArray(notificationSettings.userId, known)),
      ]);
      return buildRecipients(known, users, { devices: deviceRows, prefs: prefRows, settings: settingRows }, opts.defaultPrefs);
    },

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
      const rows = await db
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
    },

    /** Inserts a pending delivery row. False when the idempotency key already exists (do not send again). */
    async recordDelivery(d: Delivery): Promise<boolean> {
      const rows = await db
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
    },

    async finishDelivery(d: Delivery, status: 'sent' | 'failed' | 'skipped', attempts: number, error?: string): Promise<void> {
      await db
        .update(notificationDeliveries)
        .set({ status, attempts, error: error ?? null })
        .where(eq(notificationDeliveries.id, d.id));
    },

    /**
     * Upserts a device by its install id. A device row that belongs to another user is only taken over
     * when the caller also holds its current push token (same phone, new account); otherwise nothing
     * changes and this returns false, so nobody can hijack a device id they merely know.
     */
    async touchDevice(userId: string, deviceId: string, info: { platform: string; token: string; appVersion?: string }): Promise<boolean> {
      const appVersion = info.appVersion ?? '';
      // The row at deviceId that blocks a takeover: another user's, and the caller does not hold its token.
      const held = alias(devices, 'held');
      const blocked = db
        .select({ id: held.id })
        .from(held)
        .where(and(eq(held.id, deviceId), ne(held.userId, userId), ne(held.token, info.token)));
      return db.transaction(async (tx) => {
        // A push token lives on one install: drop it from any other device row first (the app was
        // reinstalled). Holding the token is proof enough, and the token column is unique. Skipped when
        // the upsert below will be refused, so a refused call changes nothing (no rollback needed).
        await tx.delete(devices).where(and(eq(devices.token, info.token), ne(devices.id, deviceId), notExists(blocked)));
        const rows = await tx
          .insert(devices)
          .values({ id: deviceId, userId, platform: info.platform, token: info.token, appVersion })
          .onConflictDoUpdate({
            target: devices.id,
            set: { userId, platform: info.platform, token: info.token, appVersion, lastSeenAt: new Date(), failureCount: 0 },
            setWhere: or(eq(devices.userId, userId), eq(devices.token, info.token)),
          })
          .returning({ id: devices.id });
        return rows.length > 0;
      });
    },

    /**
     * The device bookkeeping for one finished push delivery:
     * success resets failures; a dead address (UNREGISTERED etc.) deletes the device;
     * any other permanent failure counts a strike and deletes it at MAX_DEVICE_FAILURES;
     * retryable failures change nothing. Deletes and strikes apply only while the device
     * still holds the token that was sent to (it may have refreshed since).
     */
    async handleDeviceResult(d: Delivery, result: SendResult): Promise<void> {
      if (!d.deviceId) return;
      const sameToken = and(eq(devices.id, d.deviceId), eq(devices.token, d.to));
      if (result.ok) {
        await db.update(devices).set({ failureCount: 0 }).where(and(eq(devices.id, d.deviceId), ne(devices.failureCount, 0)));
      } else if (result.deadAddress) {
        await db.delete(devices).where(sameToken);
      } else if (!result.retryable) {
        const [row] = await db
          .update(devices)
          .set({ failureCount: sql`${devices.failureCount} + 1` })
          .where(sameToken)
          .returning({ n: devices.failureCount });
        if (row && row.n >= MAX_DEVICE_FAILURES) await db.delete(devices).where(eq(devices.id, d.deviceId));
      }
    },

    /**
     * Removes devices whose `lastSeenAt` is older than [olderThanDays] (default: the
     * `devices.pruneInactiveAfterDays` option). Null, undefined or non-positive means never prune.
     * Returns how many were removed.
     */
    async pruneDevices(olderThanDays: number | null | undefined = opts.devices?.pruneInactiveAfterDays): Promise<number> {
      if (!olderThanDays || olderThanDays <= 0) return 0;
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
      const rows = await db.delete(devices).where(lt(devices.lastSeenAt, cutoff)).returning({ id: devices.id });
      return rows.length;
    },

    /** Deletes inbox and delivery rows older than [olderThanDays]. Returns how many of each were removed. */
    async pruneHistory(olderThanDays: number): Promise<{ notifications: number; deliveries: number }> {
      const cutoff = new Date(Date.now() - olderThanDays * 86_400_000);
      const [inbox, sent] = await Promise.all([
        db.delete(notifications).where(lt(notifications.createdAt, cutoff)).returning({ id: notifications.id }),
        db.delete(notificationDeliveries).where(lt(notificationDeliveries.createdAt, cutoff)).returning({ id: notificationDeliveries.id }),
      ]);
      return { notifications: inbox.length, deliveries: sent.length };
    },
  };
}

export type DrizzleStore = ReturnType<typeof drizzleStore>;
