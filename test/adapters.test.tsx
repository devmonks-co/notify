import { beforeAll, describe, expect, it } from 'vitest';

import { DEFAULT_BRAND, renderContentEmail, resendEmail } from '../src/email/index.js';
import { fcmPush, type FcmOptions } from '../src/index.js';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('resendEmail', () => {
  const content = { title: 'Hello', body: 'World\n\nSecond', url: 'https://x.test/a' };
  const mk = (res: () => Response | Promise<Response>) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return res();
    }) as unknown as typeof fetch;
    return { calls, ch: resendEmail({ apiKey: 're_k', from: 'A <a@x.test>', fetch: f }) };
  };

  it('posts to Resend and returns the id', async () => {
    const { calls, ch } = mk(() => json(200, { id: 'em_1' }));
    expect(await ch.send('u@x.test', content, { idempotencyKey: 'k1' })).toEqual({ ok: true, providerId: 'em_1' });
    const c = calls[0]!;
    expect(c.url).toBe('https://api.resend.com/emails');
    const headers = c.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer re_k');
    expect(headers['Idempotency-Key']).toBe('k1');
    const body = JSON.parse(c.init.body as string);
    expect(body.to).toEqual(['u@x.test']);
    expect(body.subject).toBe('Hello');
    expect(body.html).toContain('<h1');
    expect(body.text).toContain('Hello');
    expect(body.text).toContain('Second');
  });
  it('maps 429 and 5xx to retryable', async () => {
    for (const status of [429, 500, 503]) {
      const r = await mk(() => json(status, { name: 'x', message: 'm' })).ch.send('u@x.test', content);
      expect(r).toMatchObject({ ok: false, retryable: true });
    }
  });
  it('maps other 4xx to not retryable and includes the reason', async () => {
    const r = await mk(() => json(422, { name: 'validation_error', message: 'bad to' })).ch.send('u@x.test', content);
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect((r as { error: string }).error).toContain('validation_error: bad to');
  });
  it('maps a network error to retryable', async () => {
    const r = await mk(() => { throw new Error('offline'); }).ch.send('u@x.test', content);
    expect(r).toMatchObject({ ok: false, retryable: true });
  });
  it('tolerates a non-JSON error body', async () => {
    const r = await mk(() => new Response('<html>bad gateway</html>', { status: 502 })).ch.send('u@x.test', content);
    expect(r).toMatchObject({ ok: false, retryable: true });
  });
});

describe('renderContentEmail', () => {
  it('falls back to simpleEmail with a button for absolute urls', async () => {
    const r = await renderContentEmail({ title: 'T', body: 'B', url: 'https://x.test/p' }, DEFAULT_BRAND);
    expect(r.html).toContain('https://x.test/p');
    expect(r.text).toContain('T');
  });
  it('uses a custom template and subject', async () => {
    const template = (p: { n: number }) => <b>{p.n}</b>;
    const r = await renderContentEmail({ title: 'T', body: 'B', email: { subject: 'S', template, props: { n: 7 } } }, DEFAULT_BRAND);
    expect(r.subject).toBe('S');
    expect(r.html).toContain('<b>7</b>');
  });
});

describe('fcmPush', () => {
  let pem = '';
  beforeAll(async () => {
    const kp = await crypto.subtle.generateKey(
      { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      true,
      ['sign', 'verify'],
    );
    const der = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
    const b64 = btoa(String.fromCharCode(...der));
    pem = `-----BEGIN PRIVATE KEY-----\n${b64.match(/.{1,64}/g)!.join('\n')}\n-----END PRIVATE KEY-----\n`;
  });

  const mk = (fcm: () => Response, defaults?: FcmOptions['defaults']) => {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.startsWith('https://oauth2.googleapis.com')) return json(200, { access_token: 'tok', expires_in: 3600 });
      return fcm();
    }) as unknown as typeof fetch;
    return { calls, ch: fcmPush({ projectId: 'proj', clientEmail: 'svc@proj.iam', privateKey: pem.replace(/\n/g, '\\n'), defaults, fetch: f }) };
  };
  const content = { title: 'Hi', body: 'There', url: '/pages/1', data: { a: 'b' } };

  it('signs a JWT, caches the token, and sends', async () => {
    const { calls, ch } = mk(() => json(200, { name: 'projects/proj/messages/1' }));
    expect(await ch.send('device1', content)).toEqual({ ok: true, providerId: 'projects/proj/messages/1' });
    await ch.send('device2', content);
    const oauth = calls.filter((c) => c.url.includes('oauth2'));
    expect(oauth).toHaveLength(1); // cached
    const assertion = new URLSearchParams(oauth[0]!.init.body as string).get('assertion')!;
    expect(assertion.split('.')).toHaveLength(3);
    const claims = JSON.parse(atob(assertion.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/')));
    expect(claims).toMatchObject({ iss: 'svc@proj.iam', aud: 'https://oauth2.googleapis.com/token' });
    const send = calls.find((c) => c.url.includes('fcm.googleapis.com'))!;
    expect(send.url).toBe('https://fcm.googleapis.com/v1/projects/proj/messages:send');
    const msg = JSON.parse(send.init.body as string).message;
    expect(msg).toEqual({
      token: 'device1',
      notification: { title: 'Hi', body: 'There' },
      data: { a: 'b', url: '/pages/1' },
      android: { priority: 'HIGH' },
      apns: { payload: { aps: { sound: 'default' } } },
    });
  });

  const messageFor = async (push: FcmOptions['defaults'], defaults?: FcmOptions['defaults']) => {
    const { calls, ch } = mk(() => json(200, {}), defaults);
    await ch.send('device1', { ...content, push });
    return JSON.parse(calls.find((c) => c.url.includes('fcm.googleapis.com'))!.init.body as string).message;
  };

  it('maps the push options to android and apns fields', async () => {
    const before = Math.floor(Date.now() / 1000);
    const msg = await messageFor({ channelId: 'alerts', badge: 3, sound: 'ping', threadId: 'chat-1', priority: 'normal', ttlSeconds: 60, collapseKey: 'price' });
    expect(msg.android).toEqual({
      priority: 'NORMAL',
      ttl: '60s',
      collapse_key: 'price',
      notification: { channel_id: 'alerts', sound: 'ping', tag: 'chat-1', notification_count: 3 },
    });
    expect(msg.apns.payload).toEqual({ aps: { badge: 3, sound: 'ping', 'thread-id': 'chat-1' } });
    expect(msg.apns.headers).toMatchObject({ 'apns-priority': '5', 'apns-collapse-id': 'price' });
    expect(Number(msg.apns.headers['apns-expiration'])).toBeGreaterThanOrEqual(before + 60);
    expect(msg.webpush).toEqual({ headers: { TTL: '60' } });
  });
  it('content.push overrides the adapter defaults per field', async () => {
    const msg = await messageFor({ badge: 1 }, { channelId: 'alerts', badge: 9 });
    expect(msg.android.notification).toEqual({ channel_id: 'alerts', notification_count: 1 });
    expect((await messageFor(undefined, { channelId: 'alerts' })).android.notification).toEqual({ channel_id: 'alerts' });
  });
  it('dataOnly sends no notification block; title and body move into data', async () => {
    const msg = await messageFor({ dataOnly: true, channelId: 'alerts', ttlSeconds: 0 });
    expect(msg.notification).toBeUndefined();
    expect(msg.data).toEqual({ title: 'Hi', body: 'There', a: 'b', url: '/pages/1' });
    expect(msg.android).toEqual({ priority: 'HIGH', ttl: '0s' });
    expect(msg.apns).toEqual({
      headers: { 'apns-push-type': 'background', 'apns-priority': '5', 'apns-expiration': '0' },
      payload: { aps: { 'content-available': 1 } },
    });
  });
  it('raw is deep-merged over the generated message and keeps its siblings', async () => {
    const msg = await messageFor({
      channelId: 'alerts',
      raw: { android: { notification: { color: '#ff0000' }, direct_boot_ok: true }, apns: { payload: { aps: { 'mutable-content': 1 } } }, webpush: { fcm_options: { link: 'https://x.test' } } },
    });
    expect(msg.android).toEqual({ priority: 'HIGH', direct_boot_ok: true, notification: { channel_id: 'alerts', color: '#ff0000' } });
    expect(msg.apns.payload.aps).toEqual({ sound: 'default', 'mutable-content': 1 });
    expect(msg.webpush).toEqual({ fcm_options: { link: 'https://x.test' } });
  });
  it('UNREGISTERED is a dead address', async () => {
    const { ch } = mk(() => json(404, { error: { status: 'NOT_FOUND', message: 'gone', details: [{ errorCode: 'UNREGISTERED' }] } }));
    expect(await ch.send('d', content)).toMatchObject({ ok: false, retryable: false, deadAddress: true });
  });
  it('INVALID_ARGUMENT about the token is a dead address', async () => {
    const byMessage = { error: { status: 'INVALID_ARGUMENT', message: 'The registration token is not a valid FCM registration token' } };
    const byField = { error: { status: 'INVALID_ARGUMENT', message: 'Invalid value', details: [{ fieldViolations: [{ field: 'message.token' }] }] } };
    for (const body of [byMessage, byField]) {
      expect(await mk(() => json(400, body)).ch.send('d', content)).toMatchObject({ ok: false, retryable: false, deadAddress: true });
    }
  });
  it('INVALID_ARGUMENT about the payload is permanent but keeps the device', async () => {
    const body = { error: { status: 'INVALID_ARGUMENT', message: 'Invalid JSON payload', details: [{ fieldViolations: [{ field: 'message.android.ttl' }] }] } };
    const r = await mk(() => json(400, body)).ch.send('d', content);
    expect(r).toMatchObject({ ok: false, retryable: false });
    expect((r as { deadAddress?: boolean }).deadAddress).toBeUndefined();
  });
  it('429 / 5xx / UNAVAILABLE are retryable, not dead', async () => {
    for (const [status, body] of [[429, { error: { status: 'RESOURCE_EXHAUSTED', details: [{ errorCode: 'QUOTA_EXCEEDED' }] } }], [503, { error: { status: 'UNAVAILABLE' } }], [500, {}]] as const) {
      const r = await mk(() => json(status, body)).ch.send('d', content);
      expect(r).toMatchObject({ ok: false, retryable: true });
      expect((r as { deadAddress?: boolean }).deadAddress).toBeUndefined();
    }
  });
  it('other 4xx is permanent but not a dead address', async () => {
    const r = await mk(() => json(403, { error: { status: 'PERMISSION_DENIED', message: 'nope' } })).ch.send('d', content);
    expect(r).toEqual({ ok: false, retryable: false, error: 'fcm 403 PERMISSION_DENIED: nope' });
  });
  it('401 is retryable and drops the cached access token', async () => {
    const { calls, ch } = mk(() => json(401, {}));
    expect(await ch.send('d', content)).toMatchObject({ ok: false, retryable: true });
    await ch.send('d', content);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(2);
  });
  it('401 THIRD_PARTY_AUTH_ERROR (APNs key missing) is permanent', async () => {
    const body = { error: { status: 'UNAUTHENTICATED', message: 'apns', details: [{ errorCode: 'THIRD_PARTY_AUTH_ERROR' }] } };
    expect(await mk(() => json(401, body)).ch.send('d', content)).toMatchObject({ ok: false, retryable: false });
  });
  it('concurrent sends share one access-token request', async () => {
    const { calls, ch } = mk(() => json(200, {}));
    await Promise.all([ch.send('d1', content), ch.send('d2', content), ch.send('d3', content)]);
    expect(calls.filter((c) => c.url.includes('oauth2'))).toHaveLength(1);
  });
  it('sends once per call: retrying is the caller\'s job', async () => {
    const { calls, ch } = mk(() => json(503, { error: { status: 'UNAVAILABLE' } }));
    await ch.send('d', content);
    expect(calls.filter((c) => c.url.includes('fcm.googleapis.com'))).toHaveLength(1);
  });
});
