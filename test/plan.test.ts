import { describe, expect, it } from 'vitest';

import { logEmail } from '../src/email/index.js';
import { createNotifier, defineNotification, inApp, logPush, logSms, type Recipient } from '../src/index.js';

const log = { info: () => {} };
const noop = async () => {};

const comment = defineNotification<{ who: string }>({
  type: 'comment.new',
  category: 'comments',
  channels: ['inApp', 'push', 'email'],
  render: ({ who }) => ({ title: `${who} commented`, body: 'hi' }),
});
const otp = defineNotification<{ code: string }>({
  type: 'auth.otp',
  category: 'account',
  channels: ['email', 'push'],
  transactional: true,
  render: ({ code }) => ({ title: 'Code', body: code }),
});

const notifier = createNotifier({
  channels: [inApp(noop), logPush(log), logEmail(log), logSms(log)],
  types: [comment, otp],
});

const base: Recipient = {
  id: 'u1',
  locale: 'en',
  timeZone: 'UTC',
  email: 'a@x.test',
  devices: [{ id: 'd1', token: 't1' }],
  prefs: {},
};
const channelsOf = (r: Recipient, type = 'comment.new', now = new Date('2026-01-01T12:00:00Z')) =>
  notifier.plan(type, r, { who: 'Sam', code: '1' }, { now, dedupeKey: 'e1' }).map((d) => d.channel).sort();

describe('plan: prefs', () => {
  it('defaults to on', () => {
    expect(channelsOf(base)).toEqual(['email', 'inApp', 'push']);
  });
  it('drops a channel set to false, keeps the rest', () => {
    expect(channelsOf({ ...base, prefs: { comments: { push: false } } })).toEqual(['email', 'inApp']);
  });
  it('other categories do not affect it', () => {
    expect(channelsOf({ ...base, prefs: { follows: { push: false } } })).toEqual(['email', 'inApp', 'push']);
  });
  it('transactional ignores prefs', () => {
    expect(channelsOf({ ...base, prefs: { account: { email: false, push: false } } }, 'auth.otp')).toEqual(['email', 'push']);
  });
});

describe('plan: addresses and fan-out', () => {
  it('skips channels with no address', () => {
    expect(channelsOf({ ...base, email: undefined, devices: [] })).toEqual(['inApp']);
  });
  it('one push delivery per device, carrying the device id', () => {
    const devices = [{ id: 'd1', token: 'a' }, { id: 'd2', token: 'b' }, { id: 'd3', token: 'a' }];
    const d = notifier.plan('comment.new', { ...base, devices }, { who: 'S' });
    const push = d.filter((x) => x.channel === 'push');
    expect(push.map((x) => [x.to, x.deviceId])).toEqual([['a', 'd1'], ['b', 'd2']]);
  });
  it('inAppEnabled=false skips the inbox', () => {
    expect(channelsOf({ ...base, inAppEnabled: false })).toEqual(['email', 'push']);
  });
  it('skips channels that are not registered', () => {
    const n = createNotifier({ channels: [logEmail(log)], types: [comment] });
    expect(n.plan('comment.new', base, { who: 'S' }).map((d) => d.channel)).toEqual(['email']);
  });
});

describe('plan: quiet hours', () => {
  const quiet = (from: string, to: string, timeZone = 'UTC'): Recipient => ({ ...base, timeZone, quietHours: { from, to } });
  it('mutes push but keeps inApp and email', () => {
    expect(channelsOf(quiet('11:00', '13:00'))).toEqual(['email', 'inApp']);
  });
  it('is off outside the window', () => {
    expect(channelsOf(quiet('13:00', '15:00'))).toEqual(['email', 'inApp', 'push']);
  });
  it('crosses midnight: 22:00-07:00', () => {
    const r = quiet('22:00', '07:00');
    expect(channelsOf(r, 'comment.new', new Date('2026-01-01T23:30:00Z'))).toEqual(['email', 'inApp']);
    expect(channelsOf(r, 'comment.new', new Date('2026-01-01T03:00:00Z'))).toEqual(['email', 'inApp']);
    expect(channelsOf(r, 'comment.new', new Date('2026-01-01T07:00:00Z'))).toEqual(['email', 'inApp', 'push']);
    expect(channelsOf(r, 'comment.new', new Date('2026-01-01T21:59:00Z'))).toEqual(['email', 'inApp', 'push']);
  });
  it('uses the recipient time zone', () => {
    // 12:00 UTC is 21:00 in Tokyo (UTC+9) and 07:00 in New York (UTC-5 in January)
    expect(channelsOf(quiet('20:00', '23:00', 'Asia/Tokyo'))).toEqual(['email', 'inApp']);
    expect(channelsOf(quiet('20:00', '23:00', 'America/New_York'))).toEqual(['email', 'inApp', 'push']);
    expect(channelsOf(quiet('22:00', '08:00', 'America/New_York'))).toEqual(['email', 'inApp']);
  });
  it('transactional ignores quiet hours', () => {
    expect(channelsOf(quiet('11:00', '13:00'), 'auth.otp')).toEqual(['email', 'push']);
  });
  it('from == to means no quiet hours; bad zone falls back to UTC', () => {
    expect(channelsOf(quiet('12:00', '12:00'))).toEqual(['email', 'inApp', 'push']);
    expect(channelsOf(quiet('11:00', '13:00', 'Nowhere/Land'))).toEqual(['email', 'inApp']);
  });
});

describe('plan: idempotency key', () => {
  const key = (r: Recipient, dedupeKey?: string, type = 'comment.new') =>
    notifier.plan(type, r, { who: 'S', code: '1' }, { dedupeKey }).map((d) => d.idempotencyKey);
  it('is stable across calls', () => {
    expect(key(base, 'c1')).toEqual(key(base, 'c1'));
  });
  it('changes with dedupeKey, recipient, type, address', () => {
    const k = key(base, 'c1');
    expect(key(base, 'c2')).not.toEqual(k);
    expect(key({ ...base, id: 'u2' }, 'c1')).not.toEqual(k);
    expect(key({ ...base, email: 'b@x.test' }, 'c1')).not.toEqual(k);
    expect(key(base, 'c1', 'auth.otp')).not.toEqual(k);
  });
  it('differs per channel and per token', () => {
    const d = notifier.plan('comment.new', { ...base, devices: [{ id: 'd1', token: 'a' }, { id: 'd2', token: 'b' }] }, { who: 'S' }, { dedupeKey: 'c1' });
    expect(new Set(d.map((x) => x.idempotencyKey)).size).toBe(d.length);
  });
  it('is unaffected by quiet hours or prefs (same event, same key)', () => {
    const all = notifier.plan('comment.new', base, { who: 'S' }, { dedupeKey: 'c1' }).find((d) => d.channel === 'email');
    const some = notifier.plan('comment.new', { ...base, prefs: { comments: { push: false } } }, { who: 'S' }, { dedupeKey: 'c1' }).find((d) => d.channel === 'email');
    expect(some?.idempotencyKey).toBe(all?.idempotencyKey);
  });
});

describe('send', () => {
  it('turns a thrown adapter error into a retryable failure', async () => {
    const n = createNotifier({
      channels: [{ name: 'email', send: async () => { throw new Error('boom'); } }],
      types: [comment],
    });
    const [d] = n.plan('comment.new', base, { who: 'S' });
    expect(await n.send(d!)).toEqual({ ok: false, retryable: true, error: 'boom' });
  });
});
