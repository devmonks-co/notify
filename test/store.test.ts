import { PGlite } from '@electric-sql/pglite';
import { generateDrizzleJson, generateMigration } from 'drizzle-kit/api';
import { drizzle } from 'drizzle-orm/pglite';
import { pgTable, uuid } from 'drizzle-orm/pg-core';
import { beforeEach, describe, expect, it } from 'vitest';

import { drizzleStore, notifyTables } from '../src/drizzle/index.js';

const users = pgTable('user', { id: uuid().primaryKey() });
const tables = notifyTables({ users });

const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';


/** The schema exactly as drizzle-kit generates it for an app with a uuid users.id. */
const ddl = async () =>
  (await generateMigration(generateDrizzleJson({}), generateDrizzleJson({ users, ...tables }))).join('\n');

async function setup() {
  const client = new PGlite();
  await client.exec(await ddl());
  await client.exec(`insert into "user" values ('${ALICE}'), ('${BOB}')`);
  const db = drizzle(client);
  const store = drizzleStore(db, tables, {
    getUser: async (id) => (id === ALICE || id === BOB ? { email: `${id}@x.test` } : null),
    defaultPrefs: { alerts: { push: true } },
  });
  return { client, db, store };
}

describe('drizzleStore', () => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup();
  });

  it('loads many recipients at once with their devices, prefs and defaults', async () => {
    await ctx.store.touchDevice(ALICE, 'install-a', { platform: 'ios', token: 'tok-a' });
    await ctx.db.insert(tables.notificationPrefs).values({ userId: BOB, category: 'alerts', channel: 'push', enabled: false });
    const map = await ctx.store.loadRecipients([ALICE, BOB, 'unknown']);
    expect([...map.keys()].sort()).toEqual([ALICE, BOB]);
    expect(map.get(ALICE)?.devices).toEqual([{ id: 'install-a', token: 'tok-a', platform: 'ios' }]);
    expect(map.get(ALICE)?.prefs).toEqual({ alerts: { push: true } });
    expect(map.get(BOB)?.prefs).toEqual({ alerts: { push: false } });
    expect(await ctx.store.loadRecipient('unknown')).toBeNull();
  });

  it('keeps a stored "__proto__" category as a plain key', async () => {
    await ctx.db.insert(tables.notificationPrefs).values({ userId: ALICE, category: '__proto__', channel: 'polluted', enabled: true });
    const alice = await ctx.store.loadRecipient(ALICE);
    expect(alice?.prefs['__proto__']).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('writes one inbox row per type, source and user', async () => {
    const content = { title: 'EUR/USD', body: 'Long' };
    expect(await ctx.store.writeInbox(ALICE, content, { type: 'alert', sourceId: 'a1', actorId: BOB })).toBe(true);
    expect(await ctx.store.writeInbox(ALICE, content, { type: 'alert', sourceId: 'a1' })).toBe(false);
    expect(await ctx.store.writeInbox(ALICE, content, { type: 'note' })).toBe(true);
    expect(await ctx.store.writeInbox(ALICE, content, { type: 'note' })).toBe(true);
    const rows = await ctx.db.select().from(tables.notifications);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.sourceId === 'a1')?.actorId).toBe(BOB);
  });

  it('records a delivery once per idempotency key', async () => {
    const delivery = { id: 'd1', idempotencyKey: 'k1', type: 'alert', recipientId: ALICE, channel: 'push', to: 'tok-a' } as const;
    expect(await ctx.store.recordDelivery(delivery as never)).toBe(true);
    expect(await ctx.store.recordDelivery({ ...delivery, id: 'd2' } as never)).toBe(false);
  });

  it('deletes a dead device at once and a failing one at the third strike', async () => {
    await ctx.store.touchDevice(ALICE, 'install-a', { platform: 'ios', token: 'tok-a' });
    await ctx.store.touchDevice(ALICE, 'install-b', { platform: 'android', token: 'tok-b' });
    const sent = (deviceId: string, to: string) => ({ deviceId, to }) as never;
    await ctx.store.handleDeviceResult(sent('install-a', 'tok-a'), { ok: false, retryable: false, deadAddress: true } as never);
    for (let i = 0; i < 3; i++) {
      await ctx.store.handleDeviceResult(sent('install-b', 'tok-b'), { ok: false, retryable: false } as never);
    }
    expect(await ctx.db.select().from(tables.devices)).toEqual([]);
  });

  it('refuses another user taking over an install id without its token', async () => {
    await ctx.store.touchDevice(ALICE, 'install-a', { platform: 'ios', token: 'tok-a' });
    expect(await ctx.store.touchDevice(BOB, 'install-a', { platform: 'ios', token: 'other' })).toBe(false);
    expect(await ctx.store.touchDevice(BOB, 'install-a', { platform: 'ios', token: 'tok-a' })).toBe(true);
  });

  it('prunes old history and devices', async () => {
    await ctx.store.writeInbox(ALICE, { title: 't', body: '' }, { type: 'old' });
    await ctx.store.recordDelivery({ id: 'd1', idempotencyKey: 'k1', type: 'old', recipientId: ALICE, channel: 'push', to: 'x' } as never);
    await ctx.store.touchDevice(ALICE, 'install-a', { platform: 'ios', token: 'tok-a' });
    await ctx.client.exec(`update notification set created_at = now() - interval '91 days';
      update notification_delivery set created_at = now() - interval '91 days';
      update notify_device set last_seen_at = now() - interval '61 days';`);
    await ctx.store.writeInbox(ALICE, { title: 'new', body: '' }, { type: 'new' });
    expect(await ctx.store.pruneHistory(90)).toEqual({ notifications: 1, deliveries: 1 });
    expect(await ctx.store.pruneDevices(60)).toBe(1);
    expect((await ctx.db.select().from(tables.notifications)).map((row) => row.type)).toEqual(['new']);
  });
});
