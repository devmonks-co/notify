import type { Channel, Content, Logger, PushOptions, SendResult } from '../types.js';
import { errorMessage, retryableStatus, tryJson } from '../util.js';

export interface FcmOptions {
  projectId: string;
  clientEmail: string;
  /** PKCS#8 PEM from the service-account JSON. Literal "\n" sequences (env vars) are accepted. */
  privateKey: string;
  /** Options for every message, e.g. `{ channelId: 'alerts' }`. `content.push` overrides them per message. */
  defaults?: PushOptions;
  /** Injected for tests; defaults to global fetch. */
  fetch?: typeof fetch;
}

const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const b64url = (data: ArrayBuffer | string) => {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data);
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

async function importKey(pem: string) {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----(BEGIN|END) PRIVATE KEY-----/g, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

/** Signed service-account JWT (RS256) for the OAuth2 jwt-bearer grant. */
async function signServiceAccountJwt(clientEmail: string, privateKey: string): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(JSON.stringify({ iss: clientEmail, scope: SCOPE, aud: TOKEN_URL, iat, exp: iat + 3600 }));
  const key = await importKey(privateKey);
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(`${header}.${claims}`));
  return `${header}.${claims}.${b64url(sig)}`;
}

type Json = Record<string, unknown>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Drops undefined values and the objects they leave empty, so optional fields can be written plainly. */
function prune(obj: Json): Json | undefined {
  const out: Json = {};
  for (const [k, v] of Object.entries(obj)) {
    const kept = isObject(v) ? prune(v) : v;
    if (kept !== undefined) out[k] = kept;
  }
  return Object.keys(out).length ? out : undefined;
}

function deepMerge(base: Json, over: Json): Json {
  const out = { ...base };
  for (const [k, v] of Object.entries(over)) {
    const b = out[k];
    out[k] = isObject(b) && isObject(v) ? deepMerge(b, v) : v;
  }
  return out;
}

/** The FCM v1 `Message` for one token. */
function fcmMessage(token: string, content: Content, o: PushOptions): Json {
  const { dataOnly = false, ttlSeconds: ttl } = o;
  const high = o.priority !== 'normal';
  const message = prune({
    token,
    notification: dataOnly ? undefined : { title: content.title, body: content.body },
    data: { ...(dataOnly ? { title: content.title, body: content.body } : {}), ...content.data, ...(content.url ? { url: content.url } : {}) },
    android: {
      priority: high ? 'HIGH' : 'NORMAL',
      ttl: ttl === undefined ? undefined : `${ttl}s`,
      collapse_key: o.collapseKey,
      notification: dataOnly ? undefined : { channel_id: o.channelId, sound: o.sound, tag: o.threadId, notification_count: o.badge },
    },
    apns: {
      headers: {
        'apns-push-type': dataOnly ? 'background' : undefined,
        // Background pushes must be 5; 10 is the APNs default for alerts.
        'apns-priority': dataOnly || !high ? '5' : undefined,
        'apns-expiration': ttl === undefined ? undefined : String(ttl === 0 ? 0 : Math.floor(Date.now() / 1000) + ttl),
        'apns-collapse-id': o.collapseKey,
      },
      payload: {
        aps: dataOnly
          ? { 'content-available': 1, badge: o.badge }
          : { badge: o.badge, sound: o.sound ?? 'default', 'thread-id': o.threadId },
      },
    },
    webpush: { headers: { TTL: ttl === undefined ? undefined : String(ttl) } },
  })!;
  return o.raw ? deepMerge(message, o.raw) : message;
}

/**
 * Push through FCM HTTP v1 (iOS goes through FCM's apns block). One attempt per call: the result says
 * whether a retry may work (`retryable`) or the token is dead (`deadAddress`); retrying is the caller's job.
 * The access token is cached until shortly before it expires. Needs only fetch and WebCrypto.
 */
export function fcmPush({ projectId, clientEmail, privateKey, defaults, fetch: f = fetch }: FcmOptions): Channel {
  let cached: { token: string; expiresAt: number } | null = null;
  let refreshing: Promise<string> | null = null;

  /** Concurrent sends share one refresh. */
  function accessToken(): Promise<string> {
    if (cached && cached.expiresAt - 60_000 > Date.now()) return Promise.resolve(cached.token);
    return (refreshing ??= fetchAccessToken().finally(() => (refreshing = null)));
  }

  async function fetchAccessToken(): Promise<string> {
    const assertion = await signServiceAccountJwt(clientEmail, privateKey);
    const res = await f(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }).toString(),
    });
    if (!res.ok) throw Object.assign(new Error(`oauth ${res.status}: ${(await res.text()).slice(0, 200)}`), { status: res.status });
    const j = (await res.json()) as { access_token: string; expires_in?: number };
    cached = { token: j.access_token, expiresAt: Date.now() + (j.expires_in ?? 3600) * 1000 };
    return j.access_token;
  }

  return {
    name: 'push',
    async send(token, content): Promise<SendResult> {
      let bearer: string;
      try {
        bearer = await accessToken();
      } catch (e) {
        const status = (e as { status?: number }).status;
        // A rejected service account is a config problem, not worth hammering; network/5xx is.
        return { ok: false, retryable: status === undefined || retryableStatus(status), error: errorMessage(e) };
      }
      let res: Response;
      try {
        res = await f(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${bearer}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ message: fcmMessage(token, content, { ...defaults, ...content.push }) }),
        });
      } catch (e) {
        return { ok: false, retryable: true, error: `network: ${errorMessage(e)}` };
      }
      if (res.ok) {
        const j = (await res.json().catch(() => ({}))) as { name?: string };
        return j.name ? { ok: true, providerId: j.name } : { ok: true };
      }
      // The access token was rejected: fetch a new one on the retry (unless another send already did).
      if (res.status === 401 && cached?.token === bearer) cached = null;
      return fcmFailure(res.status, await res.text().catch(() => ''));
    },
  };
}

/**
 * Dead token: UNREGISTERED, or INVALID_ARGUMENT that names the token. FCM also answers INVALID_ARGUMENT
 * for a bad payload (TTL, data key, size); that is permanent but must not delete the device.
 * Retryable: 401 (expired access token; not THIRD_PARTY_AUTH_ERROR, a missing APNs key), 429, 5xx and
 * UNAVAILABLE / INTERNAL / QUOTA_EXCEEDED.
 */
function fcmFailure(status: number, raw: string): SendResult {
  const err = tryJson<{
    error?: { status?: string; message?: string; details?: { errorCode?: string; fieldViolations?: { field?: string }[] }[] };
  }>(raw)?.error;
  const details = err?.details ?? [];
  const code = details.find((d) => d.errorCode)?.errorCode ?? err?.status ?? '';
  const message = err?.message ?? raw.slice(0, 300);
  const badToken = details.some((d) => d.fieldViolations?.some((v) => v.field === 'message.token'));
  const error = `fcm ${status} ${code}: ${message}`.trim();
  if (code === 'UNREGISTERED' || (code === 'INVALID_ARGUMENT' && (badToken || /registration token/i.test(message)))) {
    return { ok: false, retryable: false, error, deadAddress: true };
  }
  const retryable = (status === 401 && code !== 'THIRD_PARTY_AUTH_ERROR') || retryableStatus(status) || ['UNAVAILABLE', 'INTERNAL', 'QUOTA_EXCEEDED'].includes(code);
  return { ok: false, retryable, error };
}

/** Dev: prints the push instead of sending. */
export function logPush(logger: Logger): Channel {
  return {
    name: 'push',
    async send(token, content): Promise<SendResult> {
      logger.info(`[push] token=${token.slice(0, 12)}… ${JSON.stringify({ title: content.title, body: content.body, url: content.url, data: content.data })}`);
      return { ok: true };
    },
  };
}
