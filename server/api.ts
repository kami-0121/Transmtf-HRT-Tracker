/**
 * Cloud-backup API served by the same Cloudflare Worker as the app, backed by
 * D1 (schema: server/schema.ts, created on first use). Implements the subset of the API the
 * frontend uses for accounts and cloud sync (src/api/client.ts):
 *
 *   auth      Google sign-in (OIDC endpoints, server/google.ts) · refresh · logout
 *             · sessions (list / revoke)
 *   user      me · profile (name / avatar / greeting) · data (get / put / revision)
 *             · security PIN (status / set / change)
 *
 * Sign-in is Google only (as in AtDo): no usernames/passwords to register,
 * leak or reset. The first Google sign-in creates the account.
 *
 * Shares, avatars and statistics are not provided (501), and the UI hides
 * them when this backend is in use.
 *
 * Security notes
 * - Tokens are opaque random strings; only their SHA-256 hashes are stored.
 *   Access tokens live 1 h, refresh tokens 60 days and rotate on every refresh.
 * - The snapshot is stored gzip-compressed; with a security PIN it is
 *   additionally AES-GCM encrypted under a key derived from the PIN, which is
 *   never stored. A forgotten PIN makes the cloud copy unrecoverable (the local
 *   copy is unaffected).
 * - Snapshot uploads are rate limited per user (DATA_WRITES_PER_MINUTE).
 * - The snapshot carries a revision. An upload names the revision it was based
 *   on (`base_revision`) and is refused with 409 when another device uploaded
 *   in between, so the client merges instead of overwriting (optimistic
 *   concurrency, as in AtDo's vault items).
 * - Expired sessions and old throttling rows are purged by the daily cron
 *   (scheduledCleanup).
 */
import {
    toB64, fromB64, randomBytes, randomToken, sha256Hex,
    aesEncrypt, aesDecrypt, gzip, gunzip, encodeJson, decodeJson, utf8,
} from './crypto';
import {
    PIN_CHECK_TEXT, PIN_RE, DEVICE_TTL_MS, SESSION_TTL_MS, type DataKey, type EnvelopeRow,
    newDek, pinKek, wrapDek, unwrapDek, newRecoveryKey, normalizeRecoveryKey, recoveryKek,
    issueToken, parseToken, tokenKek, passkeyKek,
} from './keys';
import { ensureSchema } from './schema';
import {
    googleEnabled, buildAuthorizeUrl, exchangeCode, subjectHash, OAUTH_STATE_TTL_MS, type GoogleEnv,
} from './google';

export interface ApiEnv extends GoogleEnv {
    DB: D1Database;
    /** "true" stops new accounts (first-time Google sign-ins); existing ones keep working. */
    REGISTRATION_DISABLED?: string;
}

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;
// Wrong PIN / recovery key / passkey attempts per account before a pause.
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;
const UNLOCK_MAX_FAILURES = 10;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_STORED_BYTES = 1_900_000;          // D1 row limit is 2 MB
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;
// A refresh token that was just rotated is still accepted this long (another
// tab or the installed PWA may refresh with it at the same moment).
const REFRESH_GRACE_MS = 2 * 60 * 1000;
// Slow sync uploads at most every few seconds; anything far above this is a
// runaway client or abuse (the client backs off and retries later on 429).
const DATA_WRITES_PER_MINUTE = 30;
const DATA_WRITES_RETENTION_MS = 24 * 60 * 60 * 1000;

class HttpError extends Error {
    constructor(public status: number, message: string, public data?: unknown) { super(message); }
}

// API responses are JSON only: never rendered, framed or read cross-origin.
export const API_HEADERS: Record<string, string> = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Resource-Policy': 'same-origin',
};

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), { status, headers: API_HEADERS });
const ok = (data?: unknown, message?: string) => json(200, { success: true, ...(message ? { message } : {}), ...(data !== undefined ? { data } : {}) });
const fail = (status: number, error: string, data?: unknown) =>
    json(status, { success: false, error, ...(data !== undefined ? { data } : {}) });

const nowIso = () => new Date().toISOString();

async function readJson(request: Request): Promise<Record<string, unknown>> {
    const len = Number(request.headers.get('Content-Length') || 0);
    if (len > MAX_BODY_BYTES) throw new HttpError(413, 'Payload too large');
    const text = await request.text();
    if (text.length > MAX_BODY_BYTES) throw new HttpError(413, 'Payload too large');
    if (!text) return {};
    try {
        const v = JSON.parse(text);
        return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
        throw new HttpError(400, 'Invalid JSON');
    }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');


// ── rows ─────────────────────────────────────────────────────────────────────

interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    password_salt: string;
    password_iter: number;
    pin_salt: string | null;
    pin_check: string | null;
    display_name: string | null;
    avatar: string | null;
    google_picture: string | null;
    greet: number;
    key_version: number;
}
interface SessionRow {
    id: string;
    user_id: number;
    access_hash: string;
    access_expires: number;
    refresh_hash: string;
    refresh_expires: number;
    prev_access_hash: string | null;
    prev_access_expires: number | null;
    prev_refresh_hash: string | null;
    prev_refresh_until: number | null;
    device_info: string | null;
    ip_address: string | null;
    created_at: string;
    last_used_at: string;
}
interface DataRow { payload: string; is_encrypted: number; revision: number; }

const getUserById = (env: ApiEnv, id: number) =>
    env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>();
const getUserByName = (env: ApiEnv, username: string) =>
    env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first<UserRow>();

// ── sessions / tokens ────────────────────────────────────────────────────────

const deviceInfo = (request: Request) => (request.headers.get('User-Agent') || 'Unknown device').slice(0, 200);
const clientIp = (request: Request) => request.headers.get('CF-Connecting-IP') || '';

async function issueTokens(env: ApiEnv, request: Request, userId: number, sessionId?: string) {
    const access = randomToken();
    const refresh = randomToken();
    const now = Date.now();
    const accessHash = await sha256Hex(access);
    const refreshHash = await sha256Hex(refresh);
    if (sessionId) {
        // The tokens being replaced stay usable a little longer (schema v5).
        await env.DB.prepare(
            `UPDATE sessions SET prev_access_hash = access_hash, prev_access_expires = access_expires,
                prev_refresh_hash = refresh_hash, prev_refresh_until = ?,
                access_hash = ?, access_expires = ?, refresh_hash = ?, refresh_expires = ?, last_used_at = ?, ip_address = ?
             WHERE id = ?`
        ).bind(now + REFRESH_GRACE_MS, accessHash, now + ACCESS_TTL_MS, refreshHash, now + REFRESH_TTL_MS, nowIso(), clientIp(request), sessionId).run();
    } else {
        await env.DB.prepare(
            'INSERT INTO sessions (id, user_id, access_hash, access_expires, refresh_hash, refresh_expires, device_info, ip_address, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        ).bind(randomToken(16), userId, accessHash, now + ACCESS_TTL_MS, refreshHash, now + REFRESH_TTL_MS,
            deviceInfo(request), clientIp(request), nowIso(), nowIso()).run();
    }
    return { access_token: access, refresh_token: refresh, expires_in: ACCESS_TTL_MS / 1000 };
}

interface AuthContext { user: UserRow; session: SessionRow; }

async function authenticate(env: ApiEnv, request: Request): Promise<AuthContext> {
    const header = request.headers.get('Authorization') || '';
    const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
    if (!token) throw new HttpError(401, 'Unauthorized');
    const hash = await sha256Hex(token);
    const session = await env.DB.prepare('SELECT * FROM sessions WHERE access_hash = ?1 OR prev_access_hash = ?1')
        .bind(hash).first<SessionRow>();
    const expires = session?.access_hash === hash ? session.access_expires : session?.prev_access_expires ?? 0;
    if (!session || expires < Date.now()) throw new HttpError(401, 'Unauthorized');
    const user = await getUserById(env, session.user_id);
    if (!user) throw new HttpError(401, 'Unauthorized');
    // Coarse last-used tracking keeps D1 writes rare.
    if (Date.now() - Date.parse(session.last_used_at) > LAST_USED_RESOLUTION_MS) {
        await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').bind(nowIso(), session.id).run();
    }
    return { user, session };
}

// ── user data (gzip, optional PIN encryption) ────────────────────────────────

// ── unlocking the data key (server/keys.ts) ──────────────────────────────────

const badSecret = () => new HttpError(403, 'Invalid security password');

const envelopeQuery = (env: ApiEnv, userId: number, kind: string) =>
    env.DB.prepare('SELECT * FROM key_envelopes WHERE user_id = ? AND kind = ?').bind(userId, kind);

async function assertUnlockNotThrottled(env: ApiEnv, userId: number) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?')
        .bind(`unlock:${userId}`, Date.now() - UNLOCK_WINDOW_MS).first<{ n: number }>();
    if ((row?.n ?? 0) >= UNLOCK_MAX_FAILURES) throw new HttpError(429, 'Too many wrong attempts, try again in 15 minutes');
}

async function recordUnlockFailure(env: ApiEnv, userId: number) {
    await env.DB.prepare('INSERT INTO login_failures (username, at) VALUES (?, ?)').bind(`unlock:${userId}`, Date.now()).run();
}

/** Runs `open`; a failure counts towards the per-account throttle. */
async function guarded(env: ApiEnv, userId: number, open: () => Promise<DataKey>): Promise<DataKey> {
    await assertUnlockNotThrottled(env, userId);
    try {
        return await open();
    } catch (e) {
        if (e instanceof HttpError && e.status !== 403) throw e;
        await recordUnlockFailure(env, userId);
        throw badSecret();
    }
}

/**
 * Legacy accounts (key_version 1) kept the snapshot under the PIN key. On the
 * first correct PIN: create a data key, wrap it with the PIN, re-encrypt the
 * snapshot — in one transaction that only applies while still at version 1,
 * so two devices upgrading at once cannot end up with two data keys.
 */
async function upgradeLegacy(env: ApiEnv, user: UserRow, kek: CryptoKey): Promise<DataKey> {
    try {
        await aesDecrypt(kek, fromB64(user.pin_check!));
    } catch {
        throw badSecret();
    }
    const dek = await newDek();
    const stillLegacy = `EXISTS (SELECT 1 FROM users WHERE id = ${user.id} AND key_version = 1)`;
    const stmts = [
        env.DB.prepare(`INSERT INTO key_envelopes (id, user_id, kind, wrapped, created_at) SELECT ?, ?, 'pin', ?, ? WHERE ${stillLegacy}`)
            .bind(randomToken(12), user.id, await wrapDek(kek, dek), nowIso()),
    ];
    const row = await getData(env, user.id);
    if (row?.is_encrypted) {
        const payload = toB64(await aesEncrypt(dek.key, await aesDecrypt(kek, fromB64(row.payload))));
        stmts.push(env.DB.prepare(`UPDATE user_data SET payload = ?, size_bytes = ? WHERE user_id = ? AND ${stillLegacy}`)
            .bind(payload, payload.length, user.id));
    }
    stmts.push(env.DB.prepare('UPDATE users SET key_version = 2 WHERE id = ? AND key_version = 1').bind(user.id));
    const results = await env.DB.batch(stmts);
    if (results[results.length - 1].meta.changes) return dek;
    // Another request upgraded first: use its data key.
    return openWithPin(env, { ...user, key_version: 2 }, kek);
}

async function openWithPin(env: ApiEnv, user: UserRow, kek: CryptoKey): Promise<DataKey> {
    if (user.key_version < 2) return upgradeLegacy(env, user, kek);
    const envelope = await envelopeQuery(env, user.id, 'pin').first<EnvelopeRow>();
    if (!envelope) throw badSecret();
    try {
        return await unwrapDek(kek, envelope.wrapped);
    } catch {
        throw badSecret();
    }
}

const unlockWithPin = (env: ApiEnv, user: UserRow, pin: string) => guarded(env, user.id, async () => {
    if (!user.pin_salt || !PIN_RE.test(pin)) throw badSecret();
    return openWithPin(env, user, await pinKek(pin, user.pin_salt));
});

/**
 * The data key for a request: null without a security PIN (snapshot only
 * gzipped), else opened by an unlock token ("u1.<id>.<secret>", the normal
 * case) or, for older clients, the PIN itself.
 */
async function resolveDataKey(env: ApiEnv, user: UserRow, credential: string): Promise<DataKey | null> {
    if (!user.pin_salt) return null;
    const token = parseToken(credential);
    if (!token) return unlockWithPin(env, user, credential);
    const envelope = await env.DB.prepare(
        `SELECT * FROM key_envelopes WHERE id = ? AND user_id = ? AND kind IN ('device', 'session')`
    ).bind(token.id, user.id).first<EnvelopeRow>();
    if (!envelope || (envelope.expires_at ?? 0) < Date.now()) throw badSecret();
    try {
        return await unwrapDek(await tokenKek(token.secret), envelope.wrapped);
    } catch {
        throw badSecret();
    }
}

/** Issue an unlock token for this browser: 7 days if remembered, else 24 h (kept in memory). */
async function grantToken(env: ApiEnv, request: Request, userId: number, dek: DataKey, remember: boolean) {
    const issued = await issueToken(dek, remember ? DEVICE_TTL_MS : SESSION_TTL_MS);
    await env.DB.prepare(
        'INSERT INTO key_envelopes (id, user_id, kind, wrapped, label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    ).bind(issued.id, userId, remember ? 'device' : 'session', issued.wrapped, deviceInfo(request), nowIso(), issued.expiresAt).run();
    return { unlock_token: issued.token, token_id: issued.id, expires_at: issued.expiresAt, remembered: remember };
}

const pinEnvelopeStatements = async (env: ApiEnv, userId: number, pin: string, dek: DataKey) => {
    const salt = toB64(randomBytes(16));
    const kek = await pinKek(pin, salt);
    return [
        env.DB.prepare(`DELETE FROM key_envelopes WHERE user_id = ? AND kind = 'pin'`).bind(userId),
        env.DB.prepare(`INSERT INTO key_envelopes (id, user_id, kind, wrapped, created_at) VALUES (?, ?, 'pin', ?, ?)`)
            .bind(randomToken(12), userId, await wrapDek(kek, dek), nowIso()),
        env.DB.prepare('UPDATE users SET pin_salt = ?, pin_check = ?, key_version = 2 WHERE id = ?')
            .bind(salt, toB64(await aesEncrypt(kek, utf8(PIN_CHECK_TEXT))), userId),
    ];
};

const recoveryEnvelopeStatements = async (env: ApiEnv, userId: number, dek: DataKey) => {
    const recoveryKey = newRecoveryKey();
    const wrapped = await wrapDek(await recoveryKek(normalizeRecoveryKey(recoveryKey)!), dek);
    return {
        recoveryKey,
        statements: [
            env.DB.prepare(`DELETE FROM key_envelopes WHERE user_id = ? AND kind = 'recovery'`).bind(userId),
            env.DB.prepare(`INSERT INTO key_envelopes (id, user_id, kind, wrapped, created_at) VALUES (?, ?, 'recovery', ?, ?)`)
                .bind(randomToken(12), userId, wrapped, nowIso()),
        ],
    };
};

const MAX_LABEL = 80;
const cleanLabel = (value: unknown, fallback: string) =>
    (typeof value === 'string' && value.trim() ? value.trim() : fallback).slice(0, MAX_LABEL);

async function packData(value: unknown, key: CryptoKey | null): Promise<{ payload: string; encrypted: boolean }> {
    let bytes = await gzip(encodeJson(value));
    if (key) bytes = await aesEncrypt(key, bytes);
    const payload = toB64(bytes);
    if (payload.length > MAX_STORED_BYTES) throw new HttpError(413, 'Data too large for cloud backup');
    return { payload, encrypted: !!key };
}

async function unpackData(row: DataRow, key: CryptoKey | null): Promise<unknown> {
    let bytes = fromB64(row.payload);
    if (row.is_encrypted) {
        if (!key) throw new HttpError(403, 'Security password required');
        bytes = await aesDecrypt(key, bytes);
    }
    return decodeJson(await gunzip(bytes));
}

const getData = (env: ApiEnv, userId: number) =>
    env.DB.prepare('SELECT payload, is_encrypted, revision FROM user_data WHERE user_id = ?').bind(userId).first<DataRow>();

/** `null` = no base revision given (explicit "keep this device's copy"): overwrite. */
function readBaseRevision(value: unknown): number | null {
    if (value === undefined || value === null) return null;
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
        throw new HttpError(400, 'base_revision must be a non-negative integer');
    }
    return value;
}

async function enforceWriteLimit(env: ApiEnv, userId: number) {
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM data_writes WHERE user_id = ? AND at > ?')
        .bind(userId, Date.now() - 60_000).first<{ n: number }>();
    if ((row?.n ?? 0) >= DATA_WRITES_PER_MINUTE) throw new HttpError(429, 'Too many uploads, try again later');
}

/** Store the snapshot; returns its new revision. 409 when `baseRevision` is stale. */
async function putData(env: ApiEnv, userId: number, value: unknown, key: CryptoKey | null, baseRevision: number | null): Promise<number> {
    await enforceWriteLimit(env, userId);
    const { payload, encrypted } = await packData(value, key);
    // One statement, so the revision check and the write cannot interleave with
    // another device's upload. A first upload (no row yet) always succeeds.
    const [write] = await env.DB.batch([
        env.DB.prepare(
            `INSERT INTO user_data (user_id, payload, is_encrypted, size_bytes, updated_at, revision)
             VALUES (?1, ?2, ?3, ?4, ?5, 1)
             ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, is_encrypted = excluded.is_encrypted,
             size_bytes = excluded.size_bytes, updated_at = excluded.updated_at, revision = user_data.revision + 1
             WHERE ?6 IS NULL OR user_data.revision = ?6
             RETURNING revision`
        ).bind(userId, payload, encrypted ? 1 : 0, payload.length, nowIso(), baseRevision),
        env.DB.prepare('INSERT INTO data_writes (user_id, at) VALUES (?, ?)').bind(userId, Date.now()),
    ]);
    const revision = (write.results?.[0] as { revision?: number } | undefined)?.revision;
    if (typeof revision === 'number') return revision;
    const current = await env.DB.prepare('SELECT revision FROM user_data WHERE user_id = ?').bind(userId).first<{ revision: number }>();
    throw new HttpError(409, 'Cloud data changed on another device', { revision: current?.revision ?? 0 });
}

/** Daily cron: drop expired sessions and stale throttling rows. */
export async function scheduledCleanup(env: ApiEnv): Promise<void> {
    if (!env.DB) return;
    await ensureSchema(env.DB);
    const now = Date.now();
    await env.DB.batch([
        env.DB.prepare('DELETE FROM sessions WHERE refresh_expires < ?').bind(now),
        env.DB.prepare('DELETE FROM data_writes WHERE at < ?').bind(now - DATA_WRITES_RETENTION_MS),
        env.DB.prepare('DELETE FROM oauth_states WHERE expires < ?').bind(now),
        env.DB.prepare('DELETE FROM key_envelopes WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now),
        env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(now - UNLOCK_WINDOW_MS),
    ]);
}

// ── Google sign-in ───────────────────────────────────────────────────────────

function requireGoogle(env: ApiEnv) {
    if (!googleEnabled(env)) throw new HttpError(503, 'Google sign-in is not configured');
}

async function startAuthorization(env: ApiEnv, request: Request) {
    requireGoogle(env);
    const origin = new URL(request.url).origin;
    const { authUrl, state, verifier } = await buildAuthorizeUrl(env, origin);
    await env.DB.batch([
        env.DB.prepare('DELETE FROM oauth_states WHERE expires < ?').bind(Date.now()),
        env.DB.prepare('INSERT INTO oauth_states (state_hash, verifier, purpose, user_id, origin, expires) VALUES (?, ?, ?, ?, ?, ?)')
            .bind(await sha256Hex(state), verifier, 'login', null, origin, Date.now() + OAUTH_STATE_TTL_MS),
    ]);
    return ok({ auth_url: authUrl, state });
}

/** Consumes the pending authorization (single use) and returns the verified Google identity. */
async function finishAuthorization(env: ApiEnv, body: Record<string, unknown>) {
    requireGoogle(env);
    const code = str(body.code);
    const state = str(body.state);
    if (!code || !state) throw new HttpError(400, 'code and state are required');
    const row = await env.DB.prepare('DELETE FROM oauth_states WHERE state_hash = ? RETURNING verifier, purpose, user_id, origin, expires')
        .bind(await sha256Hex(state))
        .first<{ verifier: string; purpose: string; user_id: number | null; origin: string; expires: number }>();
    if (!row || row.expires < Date.now() || row.purpose !== 'login') {
        throw new HttpError(400, 'Sign-in expired or invalid, please try again');
    }
    try {
        return await exchangeCode(env, row.origin, code, row.verifier);
    } catch (e) {
        console.error('Google sign-in failed', e);
        throw new HttpError(401, 'Google sign-in failed');
    }
}

async function createGoogleUser(env: ApiEnv, subject: string, name: string | null): Promise<number> {
    for (let attempt = 0; attempt < 5; attempt++) {
        const username = `google_${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8)}`;
        if (username.length < 10 || await getUserByName(env, username)) continue;
        const res = await env.DB.prepare(
            `INSERT INTO users (username, password_hash, password_salt, password_iter, created_at, display_name) VALUES (?, '', '', 0, ?, ?)`
        ).bind(username, nowIso(), name).run();
        const userId = Number(res.meta.last_row_id);
        await env.DB.prepare(`INSERT INTO user_identities (provider, subject_hash, user_id, created_at) VALUES ('google', ?, ?, ?)`)
            .bind(subject, userId, nowIso()).run();
        return userId;
    }
    throw new HttpError(500, 'Could not create account');
}

// ── profile ──────────────────────────────────────────────────────────────────

const MAX_DISPLAY_NAME = 32;
// The client sends a square ~160 px JPEG/WebP; this bounds the stored row.
const MAX_AVATAR_CHARS = 150_000;
const AVATAR_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/]+=*$/;

/** Collapse whitespace, drop control characters, cap the length; null when empty. */
function cleanDisplayName(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const name = value.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim();
    return name ? Array.from(name).slice(0, MAX_DISPLAY_NAME).join('') : null;
}

const profileOf = (user: UserRow) => ({
    display_name: user.display_name || user.username,
    avatar_url: user.avatar || user.google_picture || null,
    has_custom_avatar: !!user.avatar,
    google_avatar_url: user.google_picture || null,
    greet: user.greet !== 0,
});

// ── routes ───────────────────────────────────────────────────────────────────

type Handler = (env: ApiEnv, request: Request, params: string[]) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/health$/, async () => ok({ status: 'ok' })],

    ['GET', /^\/api\/auth\/oidc\/config$/, async (env) =>
        ok({ oidc_enabled: googleEnabled(env), provider: 'google', registration_disabled: env.REGISTRATION_DISABLED === 'true' })],

    ['GET', /^\/api\/auth\/oidc\/authorize$/, async (env, request) => startAuthorization(env, request)],

    ['POST', /^\/api\/auth\/oidc\/callback$/, async (env, request) => {
        const google = await finishAuthorization(env, await readJson(request));
        const subject = await subjectHash(google.sub);
        const linked = await env.DB.prepare(`SELECT user_id FROM user_identities WHERE provider = 'google' AND subject_hash = ?`)
            .bind(subject).first<{ user_id: number }>();
        let userId = linked?.user_id;
        const isNew = !userId;
        if (!userId) {
            if (env.REGISTRATION_DISABLED === 'true') throw new HttpError(403, 'Registration is disabled');
            userId = await createGoogleUser(env, subject, cleanDisplayName(google.name));
        }
        // Keep the Google photo current (it is the avatar unless a custom one is
        // set); accounts from before profiles get the Google name once.
        await env.DB.prepare('UPDATE users SET google_picture = ?, display_name = COALESCE(display_name, ?) WHERE id = ?')
            .bind(google.picture ?? null, cleanDisplayName(google.name), userId).run();
        const user = await getUserById(env, userId);
        if (!user) throw new HttpError(401, 'Account not found');
        return ok({ tokens: await issueTokens(env, request, user.id), is_new_user: isNew, username: user.username, ...profileOf(user) });
    }],

    ['POST', /^\/api\/auth\/refresh$/, async (env, request) => {
        const body = await readJson(request);
        const token = str(body.refresh_token);
        if (!token) throw new HttpError(400, 'refresh_token required');
        const hash = await sha256Hex(token);
        const session = await env.DB.prepare('SELECT * FROM sessions WHERE refresh_hash = ?1 OR prev_refresh_hash = ?1')
            .bind(hash).first<SessionRow>();
        const valid = session && (session.refresh_hash === hash
            ? session.refresh_expires >= Date.now()
            : (session.prev_refresh_until ?? 0) >= Date.now());
        if (!session || !valid) throw new HttpError(401, 'Invalid refresh token');
        return ok(await issueTokens(env, request, session.user_id, session.id));
    }],

    ['POST', /^\/api\/auth\/logout$/, async (env, request) => {
        const { session } = await authenticate(env, request);
        const res = await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(session.id).run();
        return ok({ revoked_count: res.meta.changes ?? 1 }, 'Logged out successfully');
    }],

    ['GET', /^\/api\/auth\/sessions$/, async (env, request) => {
        const { user, session } = await authenticate(env, request);
        const { results } = await env.DB.prepare(
            'SELECT * FROM sessions WHERE user_id = ? AND refresh_expires > ? ORDER BY last_used_at DESC'
        ).bind(user.id, Date.now()).all<SessionRow>();
        return ok({
            current_session_id: session.id,
            sessions: results.map(s => ({
                session_id: s.id, device_info: s.device_info ?? '', ip_address: s.ip_address ?? '',
                created_at: s.created_at, last_used_at: s.last_used_at, is_current: s.id === session.id,
            })),
        });
    }],

    ['DELETE', /^\/api\/auth\/sessions\/([A-Za-z0-9_-]+)$/, async (env, request, [id]) => {
        const { user } = await authenticate(env, request);
        await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(id, user.id).run();
        return ok(undefined, 'Session revoked');
    }],

    ['DELETE', /^\/api\/auth\/sessions$/, async (env, request) => {
        const { user, session } = await authenticate(env, request);
        const res = await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, session.id).run();
        return ok({ revoked_count: res.meta.changes ?? 0 });
    }],

    ['GET', /^\/api\/user\/me$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        return ok({ username: user.username, user_id: user.id, has_password: false, ...profileOf(user) });
    }],

    // Edit the profile: { display_name?, avatar? (data URL, or null for the
    // Google photo), greet? }; omitted fields stay as they are.
    ['PUT', /^\/api\/user\/profile$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        const next = { display_name: user.display_name, avatar: user.avatar, greet: user.greet };
        if ('display_name' in body) {
            const name = cleanDisplayName(body.display_name);
            if (!name) throw new HttpError(400, 'Display name is required');
            next.display_name = name;
        }
        if ('avatar' in body) {
            if (body.avatar === null || body.avatar === '') next.avatar = null;
            else if (typeof body.avatar === 'string' && body.avatar.length <= MAX_AVATAR_CHARS && AVATAR_RE.test(body.avatar)) next.avatar = body.avatar;
            else throw new HttpError(400, 'Avatar must be a JPEG, PNG or WebP image under 100 KB');
        }
        if ('greet' in body) {
            if (typeof body.greet !== 'boolean') throw new HttpError(400, 'greet must be a boolean');
            next.greet = body.greet ? 1 : 0;
        }
        await env.DB.prepare('UPDATE users SET display_name = ?, avatar = ?, greet = ? WHERE id = ?')
            .bind(next.display_name, next.avatar, next.greet, user.id).run();
        return ok(profileOf({ ...user, ...next }));
    }],

    // What protects the cloud copy, and the passkeys a browser may offer
    // (credential ids + PRF inputs are needed before unlocking).
    ['GET', /^\/api\/user\/security-password\/status$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const { results } = await env.DB.prepare(
            `SELECT * FROM key_envelopes WHERE user_id = ? AND kind IN ('recovery', 'passkey', 'device') AND (expires_at IS NULL OR expires_at > ?)
             ORDER BY created_at`
        ).bind(user.id, Date.now()).all<EnvelopeRow>();
        return ok({
            has_security_password: !!user.pin_salt,
            // Accounts from before envelopes have none until they create one in settings.
            has_recovery_key: results.some(e => e.kind === 'recovery'),
            passkeys: results.filter(e => e.kind === 'passkey').map(e => ({
                id: e.id, credential_id: e.credential_id, prf_input: e.prf_input, label: e.label, created_at: e.created_at,
            })),
            devices: results.filter(e => e.kind === 'device').map(e => ({
                id: e.id, label: e.label, created_at: e.created_at, expires_at: e.expires_at,
            })),
        });
    }],

    // Set the PIN: creates the data key, wraps it with the PIN and a new
    // recovery key (returned once), and encrypts the existing snapshot.
    ['POST', /^\/api\/user\/security-password$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        if (user.pin_salt) throw new HttpError(409, 'Security password already set');
        const body = await readJson(request);
        const pin = str(body.password);
        if (!PIN_RE.test(pin)) throw new HttpError(400, 'Password must be 6 digits');
        const dek = await newDek();
        const recovery = await recoveryEnvelopeStatements(env, user.id, dek);
        const stmts = [...await pinEnvelopeStatements(env, user.id, pin, dek), ...recovery.statements];
        const existing = await getData(env, user.id);
        if (existing && !existing.is_encrypted) {
            const { payload } = await packData(await unpackData(existing, null), dek.key);
            stmts.push(env.DB.prepare('UPDATE user_data SET payload = ?, is_encrypted = 1, size_bytes = ? WHERE user_id = ?')
                .bind(payload, payload.length, user.id));
        }
        // One transaction: PIN, recovery key and encrypted snapshot change together.
        await env.DB.batch(stmts);
        return ok({ recovery_key: recovery.recoveryKey, ...await grantToken(env, request, user.id, dek, body.remember === true) },
            'Security password set');
    }],

    // Change the PIN: only the PIN envelope changes; the data stays as it is.
    ['PUT', /^\/api\/user\/security-password$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        const dek = await resolveDataKey(env, user, str(body.old_password));
        if (!dek) throw new HttpError(400, 'No security password set');
        const pin = str(body.new_password);
        if (!PIN_RE.test(pin)) throw new HttpError(400, 'Password must be 6 digits');
        await env.DB.batch(await pinEnvelopeStatements(env, user.id, pin, dek));
        return ok(undefined, 'Security password updated');
    }],

    // Unlock with the PIN or a passkey; returns an unlock token for this
    // browser (remember = 7 days on this device, else 24 h in memory).
    ['POST', /^\/api\/user\/security\/unlock$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        if (!user.pin_salt) throw new HttpError(400, 'No security password set');
        const body = await readJson(request);
        let dek: DataKey;
        if (body.method === 'passkey') {
            const credentialId = str(body.credential_id);
            const prfOutput = str(body.prf_output);
            dek = await guarded(env, user.id, async () => {
                const envelope = await env.DB.prepare(
                    `SELECT * FROM key_envelopes WHERE user_id = ? AND kind = 'passkey' AND credential_id = ?`
                ).bind(user.id, credentialId).first<EnvelopeRow>();
                if (!envelope || !prfOutput) throw badSecret();
                try {
                    return await unwrapDek(await passkeyKek(prfOutput), envelope.wrapped);
                } catch {
                    throw badSecret();
                }
            });
        } else {
            dek = await unlockWithPin(env, user, str(body.pin));
        }
        return ok(await grantToken(env, request, user.id, dek, body.remember === true));
    }],

    // Forgot the PIN: the recovery key opens the data key and a new PIN is set.
    ['POST', /^\/api\/user\/security\/recover$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        if (!user.pin_salt) throw new HttpError(400, 'No security password set');
        const body = await readJson(request);
        const pin = str(body.new_password);
        if (!PIN_RE.test(pin)) throw new HttpError(400, 'Password must be 6 digits');
        const canonical = normalizeRecoveryKey(str(body.recovery_key));
        const dek = await guarded(env, user.id, async () => {
            const envelope = await envelopeQuery(env, user.id, 'recovery').first<EnvelopeRow>();
            if (!envelope || !canonical) throw badSecret();
            try {
                return await unwrapDek(await recoveryKek(canonical), envelope.wrapped);
            } catch {
                throw badSecret();
            }
        });
        await env.DB.batch(await pinEnvelopeStatements(env, user.id, pin, dek));
        return ok(await grantToken(env, request, user.id, dek, body.remember === true));
    }],

    // New recovery key (shown once); the previous one stops working.
    ['POST', /^\/api\/user\/security\/recovery$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const dek = await resolveDataKey(env, user, str((await readJson(request)).password));
        if (!dek) throw new HttpError(400, 'No security password set');
        const recovery = await recoveryEnvelopeStatements(env, user.id, dek);
        await env.DB.batch(recovery.statements);
        return ok({ recovery_key: recovery.recoveryKey });
    }],

    // Add a passkey: the browser created it and evaluated its PRF; the
    // output becomes another way to open the data key.
    ['POST', /^\/api\/user\/security\/passkeys$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        const dek = await resolveDataKey(env, user, str(body.password));
        if (!dek) throw new HttpError(400, 'No security password set');
        const credentialId = str(body.credential_id);
        const prfInput = str(body.prf_input);
        const prfOutput = str(body.prf_output);
        if (!/^[A-Za-z0-9_-]{16,1024}$/.test(credentialId) || !/^[A-Za-z0-9+/=]{20,200}$/.test(prfInput) || !/^[A-Za-z0-9+/=]{20,200}$/.test(prfOutput)) {
            throw new HttpError(400, 'Invalid passkey');
        }
        const id = randomToken(12);
        await env.DB.prepare(
            `INSERT INTO key_envelopes (id, user_id, kind, wrapped, credential_id, prf_input, label, created_at) VALUES (?, ?, 'passkey', ?, ?, ?, ?, ?)`
        ).bind(id, user.id, await wrapDek(await passkeyKek(prfOutput), dek), credentialId, prfInput, cleanLabel(body.label, deviceInfo(request)), nowIso()).run();
        return ok({ id });
    }],

    ['DELETE', /^\/api\/user\/security\/passkeys\/([A-Za-z0-9_-]+)$/, async (env, request, [id]) => {
        const { user } = await authenticate(env, request);
        await env.DB.prepare(`DELETE FROM key_envelopes WHERE id = ? AND user_id = ? AND kind = 'passkey'`).bind(id, user.id).run();
        return ok(undefined, 'Passkey removed');
    }],

    // Re-issue this browser's token from the current one: start or stop
    // remembering the device without asking for the PIN again.
    ['POST', /^\/api\/user\/security\/token$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        const current = parseToken(str(body.password));
        const dek = current ? await resolveDataKey(env, user, str(body.password)) : null;
        if (!dek || !current) throw badSecret();
        const grant = await grantToken(env, request, user.id, dek, body.remember === true);
        await env.DB.prepare(`DELETE FROM key_envelopes WHERE id = ? AND user_id = ?`).bind(current.id, user.id).run();
        return ok(grant);
    }],

    // Forget one remembered device / browser session (e.g. this one on logout).
    ['DELETE', /^\/api\/user\/security\/devices\/([A-Za-z0-9_-]+)$/, async (env, request, [id]) => {
        const { user } = await authenticate(env, request);
        await env.DB.prepare(`DELETE FROM key_envelopes WHERE id = ? AND user_id = ? AND kind IN ('device', 'session')`).bind(id, user.id).run();
        return ok(undefined, 'Device forgotten');
    }],

    // Lost phone: every other device has to unlock again (passkeys stay).
    ['POST', /^\/api\/user\/security\/devices\/revoke-others$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const keep = str((await readJson(request)).keep_id);
        const res = await env.DB.prepare(
            `DELETE FROM key_envelopes WHERE user_id = ? AND kind IN ('device', 'session') AND id != ?`
        ).bind(user.id, keep).run();
        return ok({ revoked_count: res.meta.changes ?? 0 });
    }],

    // Cheap "anything new?" check (no PIN, no download, no decryption), the
    // counterpart of AtDo's incremental pull: a client whose baseline already
    // has this revision skips the full download.
    ['GET', /^\/api\/user\/data\/revision$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const row = await env.DB.prepare('SELECT revision FROM user_data WHERE user_id = ?').bind(user.id).first<{ revision: number }>();
        return ok({ revision: row?.revision ?? 0 });
    }],

    // "Get" is a POST because it may carry the PIN in the body.
    ['POST', /^\/api\/user\/data$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        const key = (await resolveDataKey(env, user, str(body.password)))?.key ?? null;
        const row = await getData(env, user.id);
        if (!row) return ok({ data: null, is_encrypted: !!key, revision: 0 });
        return ok({ data: await unpackData(row, key), is_encrypted: !!row.is_encrypted, revision: row.revision });
    }],

    ['PUT', /^\/api\/user\/data$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        if (!body.data || typeof body.data !== 'object') throw new HttpError(400, 'data required');
        const baseRevision = readBaseRevision(body.base_revision);
        const key = (await resolveDataKey(env, user, str(body.password)))?.key ?? null;
        const revision = await putData(env, user.id, body.data, key, baseRevision);
        return ok({ revision }, 'Saved');
    }],

];

/** Features of the original backend that this server does not provide. */
const UNSUPPORTED = /^\/api\/(shares|avatars|user\/avatar|statistics)(\/|$)/;
/** Username/password accounts of the original backend: sign-in is Google only here. */
const PASSWORD_AUTH = /^\/api\/(auth\/register|auth\/login|user\/password|auth\/oidc\/bind)(\/|$)/;

export async function handleApi(request: Request, env: ApiEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
        if (!env.DB) return fail(503, 'Cloud backup is not configured (missing D1 binding "DB")');
        await ensureSchema(env.DB);
        for (const [method, re, handler] of routes) {
            const m = pathname.match(re);
            if (m && request.method === method) return await handler(env, request, m.slice(1));
        }
        if (PASSWORD_AUTH.test(pathname)) return fail(410, 'Password sign-in is not available, please sign in with Google');
        if (UNSUPPORTED.test(pathname)) return fail(501, 'Not supported by this server');
        if (routes.some(([, re]) => re.test(pathname))) return fail(405, 'Method not allowed');
        return fail(404, 'Not found');
    } catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message, e.data);
        console.error('API error', e);
        return fail(500, 'Internal server error');
    }
}
