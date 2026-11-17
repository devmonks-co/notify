import { getTableConfig as pgConfig, pgTable, uuid } from 'drizzle-orm/pg-core';
import { getTableConfig, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { describe, expect, it } from 'vitest';

import { notifyTables } from '../src/drizzle/tables.js';
import { sqliteTables } from '../src/sqlite/tables.js';

const userIdType = (tables: ReturnType<typeof sqliteTables>) => ({
  notifications: tables.notifications.userId.getSQLType(),
  devices: tables.devices.userId.getSQLType(),
  prefs: tables.notificationPrefs.userId.getSQLType(),
  settings: tables.notificationSettings.userId.getSQLType(),
});

describe('sqliteTables', () => {
  // SQLite has no uuid type: the counterpart of the Postgres uuid case is an integer users.id.
  it('gives the user id columns the type of an integer users.id', () => {
    const users = sqliteTable('user', { id: integer().primaryKey() });
    expect(userIdType(sqliteTables({ users }))).toEqual({
      notifications: 'integer',
      devices: 'integer',
      prefs: 'integer',
      settings: 'integer',
    });
  });

  it('gives the user id columns the type of a text users.id', () => {
    const users = sqliteTable('user', { id: text().primaryKey() });
    expect(userIdType(sqliteTables({ users }))).toEqual({
      notifications: 'text',
      devices: 'text',
      prefs: 'text',
      settings: 'text',
    });
  });

  it('keeps only quiet hours on the settings table', () => {
    const users = sqliteTable('user', { id: text().primaryKey() });
    const { columns } = getTableConfig(sqliteTables({ users }).notificationSettings);
    expect(columns.map((column) => column.name).sort()).toEqual([
      'quiet_from',
      'quiet_to',
      'updated_at',
      'user_id',
    ]);
  });

  it('has the same tables, columns, indexes and foreign keys as the Postgres notifyTables', () => {
    const lite = sqliteTables({ users: sqliteTable('user', { id: text().primaryKey() }) });
    const pg = notifyTables({ users: pgTable('user', { id: uuid().primaryKey() }) });
    const shape = (c: { name: string; columns: { name: string; notNull: boolean; primary: boolean }[]; indexes: { config: { name: string; unique: boolean } }[]; foreignKeys: unknown[] }) => ({
      name: c.name,
      columns: c.columns.map(({ name, notNull, primary }) => ({ name, notNull, primary })),
      indexes: c.indexes.map(({ config }) => ({ name: config.name, unique: config.unique })),
      foreignKeys: c.foreignKeys.length,
    });
    for (const key of Object.keys(pg) as (keyof typeof pg)[]) {
      expect(shape(getTableConfig(lite[key]) as never)).toEqual(shape(pgConfig(pg[key]) as never));
    }
  });
});
