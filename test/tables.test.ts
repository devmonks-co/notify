import { getTableConfig, pgTable, text, uuid } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { notifyTables } from '../src/drizzle/tables.js';

const userIdType = (tables: ReturnType<typeof notifyTables>) => ({
  notifications: tables.notifications.userId.getSQLType(),
  devices: tables.devices.userId.getSQLType(),
  prefs: tables.notificationPrefs.userId.getSQLType(),
  settings: tables.notificationSettings.userId.getSQLType(),
});

describe('notifyTables', () => {
  it('gives the user id columns the type of a uuid users.id', () => {
    const users = pgTable('user', { id: uuid().primaryKey() });
    expect(userIdType(notifyTables({ users }))).toEqual({
      notifications: 'uuid',
      devices: 'uuid',
      prefs: 'uuid',
      settings: 'uuid',
    });
  });

  it('gives the user id columns the type of a text users.id', () => {
    const users = pgTable('user', { id: text().primaryKey() });
    expect(userIdType(notifyTables({ users }))).toEqual({
      notifications: 'text',
      devices: 'text',
      prefs: 'text',
      settings: 'text',
    });
  });

  it('keeps only quiet hours on the settings table', () => {
    const users = pgTable('user', { id: uuid().primaryKey() });
    const { columns } = getTableConfig(notifyTables({ users }).notificationSettings);
    expect(columns.map((column) => column.name).sort()).toEqual([
      'quiet_from',
      'quiet_to',
      'updated_at',
      'user_id',
    ]);
  });
});
