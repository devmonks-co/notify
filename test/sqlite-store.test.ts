import Database from 'better-sqlite3';
import { generateSQLiteDrizzleJson, generateSQLiteMigration } from 'drizzle-kit/api';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { integer, sqliteTable, text, type AnySQLiteTable } from 'drizzle-orm/sqlite-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { D1Store } from '../src/d1/index.js';
import { SqliteStore, sqliteTables, type AnySqliteDb, type AtomicStatement, type SqliteStoreOptions, type SqliteTables } from '../src/sqlite/index.js';

const users = sqliteTable('user', { id: text().primaryKey() });
const tables = sqliteTables({ users });

const ALICE = '00000000-0000-4000-8000-00000000000a';
const BOB = '00000000-0000-4000-8000-00000000000b';

/** The schema exactly as drizzle-kit generates it for an app with the given users table. */
const ddl = async (schema: Record<string, AnySQLiteTable>) =>
  (await generateSQLiteMigration(await generateSQLiteDrizzleJson({}), await generateSQLiteDrizzleJson(schema))).join('\n');

/**
 * D1's contract without D1: the statements are handed over up front and run in order, outside any
 * `db.transaction`. A store that branched on a result mid-transaction, or threw to roll back, fails here.
 */
class SequentialStore extends SqliteStore {
  protected override async atomic(statements: readonly AtomicStatement[]): Promise<unknown[][]> {
    const results: unknown[][] = [];
    for (const statement of statements) results.push(await (statement as unknown as PromiseLike<unknown[]>));
    return results;
  }
}

type MakeStore = (db: AnySqliteDb, tables: SqliteTables, opts: SqliteStoreOptions) => SqliteStore;

async function setup(makeStore: MakeStore) {
  const client = new Database(':memory:');
  client.exec(await ddl({ users, ...tables }));
  client.prepare('insert into "user" values (?), (?)').run(ALICE, BOB);
  const db = drizzle(client);
  const store = makeStore(db, tables, {
    getUser: async (id) => (id === ALICE || id === BOB ? { email: `${id}@x.test` } : null),
    defaultPrefs: { alerts: { push: true } },
  });
  return { client, db, store };
}

const variants: [string, MakeStore][] = [
  ['transaction atomic', (db, t, opts) => new SqliteStore(db, t, opts)],
  ['batch-like atomic', (db, t, opts) => new SequentialStore(db, t, opts)],
];

describe.each(variants)('SqliteStore (%s)', (_name, makeStore) => {
  let ctx: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => {
    ctx = await setup(makeStore);
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

  it('loads more recipients than one IN list may bind on D1', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `u${i}`);
    ctx.client.prepare(`insert into "user" values ${ids.map(() => '(?)').join(', ')}`).run(...ids);
    await ctx.store.touchDevice('u249', 'install-z', { platform: 'ios', token: 'tok-z' });
    const store = makeStore(ctx.db, tables, { getUser: async () => ({}) });
    const map = await store.loadRecipients(ids);
    expect(map.size).toBe(250);
    expect(map.get('u249')?.devices).toEqual([{ id: 'install-z', token: 'tok-z', platform: 'ios' }]);
  });

  it('keeps a stored "__proto__" category as a plain key', async () => {
    await ctx.db.insert(tables.notificationPrefs).values({ userId: ALICE, category: '__proto__', channel: 'polluted', enabled: true });
    const alice = await ctx.store.loadRecipient(ALICE);
    expect(alice?.prefs['__proto__']).toEqual({ polluted: true });
    expect(({} as Record<string, unknown>)['polluted']).toBeUndefined();
  });

  it('writes one inbox row per type, source and user', async () => {
    const content = { title: 'EUR/USD', body: 'Long' };
    const first = await ctx.store.writeInbox(ALICE, content, { type: 'alert', sourceId: 'a1', actorId: BOB });
    expect(first).toEqual(expect.any(String));
    expect(await ctx.store.writeInbox(ALICE, content, { type: 'alert', sourceId: 'a1' })).toBeNull();
    expect(await ctx.store.writeInbox(ALICE, content, { type: 'note' })).toEqual(expect.any(String));
    expect(await ctx.store.writeInbox(ALICE, content, { type: 'note' })).toEqual(expect.any(String));
    const rows = await ctx.db.select().from(tables.notifications);
    expect(rows).toHaveLength(3);
    expect(rows.find((row) => row.sourceId === 'a1')).toMatchObject({ id: first, actorId: BOB, data: {} });
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
    for (let i = 0; i < 2; i++) {
      await ctx.store.handleDeviceResult(sent('install-b', 'tok-b'), { ok: false, retryable: false } as never);
    }
    expect((await ctx.db.select().from(tables.devices)).map((row) => row.failureCount)).toEqual([2]);
    await ctx.store.handleDeviceResult(sent('install-b', 'tok-b'), { ok: false, retryable: false } as never);
    expect(await ctx.db.select().from(tables.devices)).toEqual([]);
  });

  it('changes nothing when it refuses, not even the token on another install', async () => {
    await ctx.store.touchDevice(ALICE, 'install-a', { platform: 'ios', token: 'tok-a' });
    await ctx.store.touchDevice(BOB, 'install-b', { platform: 'ios', token: 'tok-b' });
    const before = ctx.client.prepare('select * from notify_device order by id').all();
    expect(await ctx.store.touchDevice(BOB, 'install-a', { platform: 'android', token: 'tok-b', appVersion: '9' })).toBe(false);
    expect(ctx.client.prepare('select * from notify_device order by id').all()).toEqual(before);
    const rows = await ctx.db.select({ id: tables.devices.id, token: tables.devices.token }).from(tables.devices);
    expect(rows.sort((a, b) => a.id.localeCompare(b.id))).toEqual([
      { id: 'install-a', token: 'tok-a' },
      { id: 'install-b', token: 'tok-b' },
    ]);
  });

  it('moves a token to the new install id when the same user reinstalls', async () => {
    await ctx.store.touchDevice(ALICE, 'install-a', { platform: 'ios', token: 'tok-a' });
    expect(await ctx.store.touchDevice(ALICE, 'install-a2', { platform: 'ios', token: 'tok-a' })).toBe(true);
    expect(await ctx.db.select({ id: tables.devices.id }).from(tables.devices)).toEqual([{ id: 'install-a2' }]);
  });

  it('stores timestamps at millisecond precision, so they read back equal to a Date', async () => {
    // SQLite has no timestamp precision to inspect: check the stored value is integer milliseconds, also from the SQL default.
    const t0 = Date.now();
    ctx.client.prepare("insert into notification (id, user_id, type, title) values ('raw', ?, 'raw', 'raw')").run(ALICE);
    const { created_at: raw } = ctx.client.prepare("select created_at from notification where id = 'raw'").get() as { created_at: number };
    expect(Number.isInteger(raw)).toBe(true);
    expect(Math.abs(raw - t0)).toBeLessThan(5_000);
    const at = new Date(1_700_000_000_123);
    await ctx.db.insert(tables.notifications).values({ id: 'ms', userId: ALICE, type: 'ms', title: 'ms', createdAt: at });
    const [row] = await ctx.db.select({ createdAt: tables.notifications.createdAt }).from(tables.notifications).where(eq(tables.notifications.id, 'ms'));
    expect(row?.createdAt).toEqual(at);
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
    const day = 86_400_000;
    ctx.client.exec(`update notification set created_at = created_at - 91 * ${day};
      update notification_delivery set created_at = created_at - 91 * ${day};
      update notify_device set last_seen_at = last_seen_at - 61 * ${day};`);
    await ctx.store.writeInbox(ALICE, { title: 'new', body: '' }, { type: 'new' });
    expect(await ctx.store.pruneHistory(90)).toEqual({ notifications: 1, deliveries: 1 });
    expect(await ctx.store.pruneDevices(60)).toBe(1);
    expect((await ctx.db.select().from(tables.notifications)).map((row) => row.type)).toEqual(['new']);
  });
});

describe('SqliteStore.atomic', () => {
  it('rolls every statement back when one fails', async () => {
    class Exposed extends SqliteStore {
      run(statements: AtomicStatement[]) {
        return this.atomic(statements);
      }
    }
    const { client, db } = await setup((d, t, o) => new SqliteStore(d, t, o));
    const store = new Exposed(db, tables, { getUser: async () => null });
    const device = { id: 'install-a', userId: ALICE, platform: 'ios', token: 'tok-a' };
    const insert = () => db.insert(tables.devices).values(device).returning({ id: tables.devices.id });
    await expect(store.run([insert(), insert()])).rejects.toThrow(/UNIQUE/);
    expect(client.prepare('select count(*) as n from notify_device').get()).toEqual({ n: 0 });
    expect(await store.run([insert()])).toEqual([[{ id: 'install-a' }]]);
  });
});

describe('SqliteStore with an integer users.id', () => {
  it('reads and writes the user ids as strings', async () => {
    const intUsers = sqliteTable('user', { id: integer().primaryKey() });
    const intTables = sqliteTables({ users: intUsers });
    const client = new Database(':memory:');
    client.exec(await ddl({ users: intUsers, ...intTables }));
    client.exec('insert into "user" values (7)');
    const store = new SqliteStore(drizzle(client), intTables, { getUser: async (id) => (id === '7' ? {} : null) });
    expect(await store.touchDevice('7', 'install-a', { platform: 'ios', token: 'tok-a' })).toBe(true);
    expect(await store.writeInbox('7', { title: 't', body: '' })).toEqual(expect.any(String));
    expect(client.prepare('select typeof(user_id) as t from notify_device').get()).toEqual({ t: 'integer' });
    expect((await store.loadRecipient('7'))?.devices).toEqual([{ id: 'install-a', token: 'tok-a', platform: 'ios' }]);
  });
});

describe('D1Store', () => {
  it('runs the all-or-none writes as one db.batch of the statements', async () => {
    const client = new Database(':memory:');
    client.exec(await ddl({ users, ...tables }));
    const real = drizzle(client);
    // A fake D1 database: builds queries like the real one, records what `batch` gets.
    let rows: unknown[] = [{ id: 'install-a' }];
    const batch = vi.fn(async (statements: readonly AtomicStatement[]) => statements.map(() => rows));
    const transaction = vi.fn();
    const db = Object.assign(Object.create(real), { batch, transaction });
    const store = new D1Store(db, tables, { getUser: async () => null });
    expect(await store.touchDevice(ALICE, 'install-a', { platform: 'ios', token: 'tok-a' })).toBe(true);
    expect(batch).toHaveBeenCalledTimes(1);
    const [statements] = batch.mock.calls[0]!;
    const verbs = statements.map((s) => (s as unknown as { toSQL(): { sql: string } }).toSQL().sql.split(' ')[0]);
    expect(verbs).toEqual(['delete', 'insert']);
    rows = [];
    expect(await store.touchDevice(BOB, 'install-a', { platform: 'ios', token: 'other' })).toBe(false);
    expect(transaction).not.toHaveBeenCalled();
  });
});
