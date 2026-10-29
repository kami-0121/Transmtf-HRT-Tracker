/**
 * Cloud-backup API served by the same Cloudflare Worker as the app, backed by
 * D1 (schema: server/schema.ts, created on first use). Implements the subset of the API the
 * frontend uses for accounts and cloud sync (src/api/client.ts):
 *
 *   auth      register · login · refresh · logout · sessions (list / revoke)
 *   user      me · data (get / put) · security PIN (status / set / change) · password
 *
 * Shares, avatars, OIDC and statistics are not provided (501), and the UI
 * hides them when this backend is in use.
 *
 * Security notes
 * - Login passwords: PBKDF2-SHA256 with a per-user salt; the iteration count is
 *   stored per user so it can be raised later (rehash on next login).
 * - Tokens are opaque random strings; only their SHA-256 hashes are stored.
 *   Access tokens live 1 h, refresh tokens 60 days and rotate on every refresh.
 * - The snapshot is stored gzip-compressed; with a security PIN it is
 *   additionally AES-GCM encrypted under a key derived from the PIN, which is
 *   never stored. A forgotten PIN makes the cloud copy unrecoverable (the local
 *   copy is unaffected).
 * - Failed logins are throttled per username.
 */
import {
    toB64, fromB64, randomBytes, randomToken, sha256Hex, timingSafeEqual, pbkdf2,
    pinKey, aesEncrypt, aesDecrypt, gzip, gunzip, encodeJson, decodeJson, utf8,
} from './crypto';
import { ensureSchema } from './schema';

export interface ApiEnv {
    DB: D1Database;
    /** Optional: when set, register/login require a valid Turnstile token. */
    TURNSTILE_SECRET_KEY?: string;
    /** "true" closes registration (existing accounts keep working). */
    REGISTRATION_DISABLED?: string;
    /** PBKDF2 iterations for login passwords (default 100000). */
    PASSWORD_PBKDF2_ITERATIONS?: string;
}

const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const PIN_ITERATIONS = 10_000;
const PIN_CHECK_TEXT = 'hrt-tracker-pin-check-v1';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_STORED_BYTES = 1_900_000;          // D1 row limit is 2 MB
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const LOGIN_MAX_FAILURES = 10;
const LAST_USED_RESOLUTION_MS = 60 * 60 * 1000;

class HttpError extends Error {
    constructor(public status: number, message: string) { super(message); }
}

const json = (status: number, body: unknown): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
    });
const ok = (data?: unknown, message?: string) => json(200, { success: true, ...(message ? { message } : {}), ...(data !== undefined ? { data } : {}) });
const fail = (status: number, error: string) => json(status, { success: false, error });

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

const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const validatePassword = (p: string): string | null => {
    if (p.length < 8) return 'Password must be at least 8 characters';
    if (p.length > 256) return 'Password too long';
    if (!/[A-Za-z]/.test(p) || !/[0-9]/.test(p)) return 'Password must contain letters and numbers';
    return null;
};
const PIN_RE = /^\d{6}$/;

// ── password hashing ─────────────────────────────────────────────────────────

const passwordIterations = (env: ApiEnv) => {
    const n = Number(env.PASSWORD_PBKDF2_ITERATIONS);
    return Number.isFinite(n) && n >= 10_000 ? Math.floor(n) : 100_000;
};

async function hashPassword(password: string, iterations: number) {
    const salt = randomBytes(16);
    const hash = await pbkdf2(password, salt, iterations);
    return { hash: toB64(hash), salt: toB64(salt), iterations };
}

async function verifyPassword(password: string, user: UserRow): Promise<boolean> {
    const hash = await pbkdf2(password, fromB64(user.password_salt), user.password_iter);
    return timingSafeEqual(hash, fromB64(user.password_hash));
}

// ── rows ─────────────────────────────────────────────────────────────────────

interface UserRow {
    id: number;
    username: string;
    password_hash: string;
    password_salt: string;
    password_iter: number;
    pin_salt: string | null;
    pin_check: string | null;
}
interface SessionRow {
    id: string;
    user_id: number;
    access_expires: number;
    refresh_expires: number;
    device_info: string | null;
    ip_address: string | null;
    created_at: string;
    last_used_at: string;
}
interface DataRow { payload: string; is_encrypted: number; }

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
        await env.DB.prepare(
            'UPDATE sessions SET access_hash = ?, access_expires = ?, refresh_hash = ?, refresh_expires = ?, last_used_at = ?, ip_address = ? WHERE id = ?'
        ).bind(accessHash, now + ACCESS_TTL_MS, refreshHash, now + REFRESH_TTL_MS, nowIso(), clientIp(request), sessionId).run();
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
    const session = await env.DB.prepare('SELECT * FROM sessions WHERE access_hash = ?')
        .bind(await sha256Hex(token)).first<SessionRow>();
    if (!session || session.access_expires < Date.now()) throw new HttpError(401, 'Unauthorized');
    const user = await getUserById(env, session.user_id);
    if (!user) throw new HttpError(401, 'Unauthorized');
    // Coarse last-used tracking keeps D1 writes rare.
    if (Date.now() - Date.parse(session.last_used_at) > LAST_USED_RESOLUTION_MS) {
        await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').bind(nowIso(), session.id).run();
    }
    return { user, session };
}

// ── Turnstile / throttling ───────────────────────────────────────────────────

async function checkTurnstile(env: ApiEnv, request: Request, token: string) {
    if (!env.TURNSTILE_SECRET_KEY) return;
    if (!token) throw new HttpError(400, 'Turnstile verification required');
    const form = new FormData();
    form.append('secret', env.TURNSTILE_SECRET_KEY);
    form.append('response', token);
    const ip = clientIp(request);
    if (ip) form.append('remoteip', ip);
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', { method: 'POST', body: form });
    const outcome = await res.json<{ success?: boolean }>().catch(() => ({ success: false }));
    if (!outcome.success) throw new HttpError(403, 'Turnstile verification failed');
}

async function assertNotThrottled(env: ApiEnv, username: string) {
    const since = Date.now() - LOGIN_WINDOW_MS;
    const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM login_failures WHERE username = ? AND at > ?')
        .bind(username, since).first<{ n: number }>();
    if ((row?.n ?? 0) >= LOGIN_MAX_FAILURES) throw new HttpError(429, 'Too many failed attempts, try again later');
}

async function recordFailure(env: ApiEnv, username: string) {
    await env.DB.batch([
        env.DB.prepare('INSERT INTO login_failures (username, at) VALUES (?, ?)').bind(username, Date.now()),
        env.DB.prepare('DELETE FROM login_failures WHERE at < ?').bind(Date.now() - LOGIN_WINDOW_MS),
    ]);
}

// ── user data (gzip, optional PIN encryption) ────────────────────────────────

async function pinKeyFor(user: UserRow, pin: string): Promise<CryptoKey> {
    if (!user.pin_salt || !user.pin_check) throw new HttpError(400, 'No security password set');
    if (!PIN_RE.test(pin)) throw new HttpError(401, 'Invalid security password');
    const key = await pinKey(pin, fromB64(user.pin_salt), PIN_ITERATIONS);
    try {
        await aesDecrypt(key, fromB64(user.pin_check));
    } catch {
        throw new HttpError(401, 'Invalid security password');
    }
    return key;
}

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
        if (!key) throw new HttpError(401, 'Security password required');
        bytes = await aesDecrypt(key, bytes);
    }
    return decodeJson(await gunzip(bytes));
}

const getData = (env: ApiEnv, userId: number) =>
    env.DB.prepare('SELECT payload, is_encrypted FROM user_data WHERE user_id = ?').bind(userId).first<DataRow>();

async function putData(env: ApiEnv, userId: number, value: unknown, key: CryptoKey | null) {
    const { payload, encrypted } = await packData(value, key);
    await env.DB.prepare(
        `INSERT INTO user_data (user_id, payload, is_encrypted, size_bytes, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET payload = excluded.payload, is_encrypted = excluded.is_encrypted,
         size_bytes = excluded.size_bytes, updated_at = excluded.updated_at`
    ).bind(userId, payload, encrypted ? 1 : 0, payload.length, nowIso()).run();
}

// ── routes ───────────────────────────────────────────────────────────────────

type Handler = (env: ApiEnv, request: Request, params: string[]) => Promise<Response>;

const routes: [string, RegExp, Handler][] = [
    ['GET', /^\/api\/health$/, async () => ok({ status: 'ok' })],

    ['GET', /^\/api\/auth\/oidc\/config$/, async (env) =>
        ok({ oidc_enabled: false, registration_disabled: env.REGISTRATION_DISABLED === 'true' })],

    ['POST', /^\/api\/auth\/register$/, async (env, request) => {
        if (env.REGISTRATION_DISABLED === 'true') throw new HttpError(403, 'Registration is disabled');
        const body = await readJson(request);
        const username = str(body.username).trim();
        const password = str(body.password);
        if (!USERNAME_RE.test(username)) throw new HttpError(400, 'Username must be 3–32 letters, digits, _ . -');
        const pwError = validatePassword(password);
        if (pwError) throw new HttpError(400, pwError);
        await checkTurnstile(env, request, str(body.turnstile_token));
        if (await getUserByName(env, username)) throw new HttpError(409, 'Username already exists');
        const h = await hashPassword(password, passwordIterations(env));
        const res = await env.DB.prepare(
            'INSERT INTO users (username, password_hash, password_salt, password_iter, created_at) VALUES (?, ?, ?, ?, ?)'
        ).bind(username, h.hash, h.salt, h.iterations, nowIso()).run();
        const userId = Number(res.meta.last_row_id);
        return ok(await issueTokens(env, request, userId), 'Registered');
    }],

    ['POST', /^\/api\/auth\/login$/, async (env, request) => {
        const body = await readJson(request);
        const username = str(body.username).trim();
        const password = str(body.password);
        if (!username || !password) throw new HttpError(400, 'Username and password are required');
        await assertNotThrottled(env, username);
        await checkTurnstile(env, request, str(body.turnstile_token));
        const user = await getUserByName(env, username);
        // Unknown users still pay the hashing cost so timing doesn't reveal which names exist.
        if (!user) await pbkdf2(password, randomBytes(16), passwordIterations(env));
        if (!user || !(await verifyPassword(password, user))) {
            await recordFailure(env, username);
            throw new HttpError(401, 'Invalid username or password');
        }
        // Upgrade the stored hash when the configured iteration count changed.
        const target = passwordIterations(env);
        if (user.password_iter !== target) {
            const h = await hashPassword(password, target);
            await env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ? WHERE id = ?')
                .bind(h.hash, h.salt, h.iterations, user.id).run();
        }
        return ok(await issueTokens(env, request, user.id), 'Logged in');
    }],

    ['POST', /^\/api\/auth\/refresh$/, async (env, request) => {
        const body = await readJson(request);
        const token = str(body.refresh_token);
        if (!token) throw new HttpError(400, 'refresh_token required');
        const session = await env.DB.prepare('SELECT * FROM sessions WHERE refresh_hash = ?')
            .bind(await sha256Hex(token)).first<SessionRow>();
        if (!session || session.refresh_expires < Date.now()) throw new HttpError(401, 'Invalid refresh token');
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
        const body = await readJson(request);
        if (!(await verifyPassword(str(body.password), user))) throw new HttpError(403, 'Invalid password');
        await env.DB.prepare('DELETE FROM sessions WHERE id = ? AND user_id = ?').bind(id, user.id).run();
        return ok(undefined, 'Session revoked');
    }],

    ['DELETE', /^\/api\/auth\/sessions$/, async (env, request) => {
        const { user, session } = await authenticate(env, request);
        const body = await readJson(request);
        if (!(await verifyPassword(str(body.password), user))) throw new HttpError(403, 'Invalid password');
        const res = await env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, session.id).run();
        return ok({ revoked_count: res.meta.changes ?? 0 });
    }],

    ['GET', /^\/api\/user\/me$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        return ok({ username: user.username, user_id: user.id });
    }],

    ['GET', /^\/api\/user\/security-password\/status$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        return ok({ has_security_password: !!user.pin_salt });
    }],

    ['POST', /^\/api\/user\/security-password$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        if (user.pin_salt) throw new HttpError(409, 'Security password already set');
        const pin = str((await readJson(request)).password);
        if (!PIN_RE.test(pin)) throw new HttpError(400, 'Password must be 6 digits');
        const salt = randomBytes(16);
        const key = await pinKey(pin, salt, PIN_ITERATIONS);
        const check = toB64(await aesEncrypt(key, utf8(PIN_CHECK_TEXT)));
        const existing = await getData(env, user.id);
        const stmts = [env.DB.prepare('UPDATE users SET pin_salt = ?, pin_check = ? WHERE id = ?').bind(toB64(salt), check, user.id)];
        if (existing) {
            const value = await unpackData(existing, null);
            const { payload } = await packData(value, key);
            stmts.push(env.DB.prepare('UPDATE user_data SET payload = ?, is_encrypted = 1, size_bytes = ?, updated_at = ? WHERE user_id = ?')
                .bind(payload, payload.length, nowIso(), user.id));
        }
        await env.DB.batch(stmts);
        return ok(undefined, 'Security password set');
    }],

    ['PUT', /^\/api\/user\/security-password$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        const oldKey = await pinKeyFor(user, str(body.old_password));
        const pin = str(body.new_password);
        if (!PIN_RE.test(pin)) throw new HttpError(400, 'Password must be 6 digits');
        const salt = randomBytes(16);
        const key = await pinKey(pin, salt, PIN_ITERATIONS);
        const check = toB64(await aesEncrypt(key, utf8(PIN_CHECK_TEXT)));
        const existing = await getData(env, user.id);
        const stmts = [env.DB.prepare('UPDATE users SET pin_salt = ?, pin_check = ? WHERE id = ?').bind(toB64(salt), check, user.id)];
        if (existing) {
            const value = await unpackData(existing, oldKey);
            const { payload } = await packData(value, key);
            stmts.push(env.DB.prepare('UPDATE user_data SET payload = ?, is_encrypted = 1, size_bytes = ?, updated_at = ? WHERE user_id = ?')
                .bind(payload, payload.length, nowIso(), user.id));
        }
        await env.DB.batch(stmts);
        return ok(undefined, 'Security password updated');
    }],

    // "Get" is a POST because it may carry the PIN in the body.
    ['POST', /^\/api\/user\/data$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        const key = user.pin_salt ? await pinKeyFor(user, str(body.password)) : null;
        const row = await getData(env, user.id);
        if (!row) return ok({ data: null, is_encrypted: !!key });
        return ok({ data: await unpackData(row, key), is_encrypted: !!row.is_encrypted });
    }],

    ['PUT', /^\/api\/user\/data$/, async (env, request) => {
        const { user } = await authenticate(env, request);
        const body = await readJson(request);
        if (!body.data || typeof body.data !== 'object') throw new HttpError(400, 'data required');
        const key = user.pin_salt ? await pinKeyFor(user, str(body.password)) : null;
        await putData(env, user.id, body.data, key);
        return ok(undefined, 'Saved');
    }],

    ['PUT', /^\/api\/user\/password$/, async (env, request) => {
        const { user, session } = await authenticate(env, request);
        const body = await readJson(request);
        if (!(await verifyPassword(str(body.old_password), user))) throw new HttpError(403, 'Invalid password');
        const pwError = validatePassword(str(body.new_password));
        if (pwError) throw new HttpError(400, pwError);
        const h = await hashPassword(str(body.new_password), passwordIterations(env));
        const [, revoked] = await env.DB.batch([
            env.DB.prepare('UPDATE users SET password_hash = ?, password_salt = ?, password_iter = ? WHERE id = ?')
                .bind(h.hash, h.salt, h.iterations, user.id),
            env.DB.prepare('DELETE FROM sessions WHERE user_id = ? AND id != ?').bind(user.id, session.id),
        ]);
        return ok({ message: 'Password changed', other_sessions_logged_out: revoked.meta.changes ?? 0 });
    }],
];

/** Features of the original backend that this server does not provide. */
const UNSUPPORTED = /^\/api\/(shares|avatars|user\/avatar|statistics|auth\/oidc)(\/|$)/;

export async function handleApi(request: Request, env: ApiEnv): Promise<Response> {
    const { pathname } = new URL(request.url);
    try {
        if (!env.DB) return fail(503, 'Cloud backup is not configured (missing D1 binding "DB")');
        await ensureSchema(env.DB);
        for (const [method, re, handler] of routes) {
            const m = pathname.match(re);
            if (m && request.method === method) return await handler(env, request, m.slice(1));
        }
        if (UNSUPPORTED.test(pathname)) return fail(501, 'Not supported by this server');
        if (routes.some(([, re]) => re.test(pathname))) return fail(405, 'Method not allowed');
        return fail(404, 'Not found');
    } catch (e) {
        if (e instanceof HttpError) return fail(e.status, e.message);
        console.error('API error', e);
        return fail(500, 'Internal server error');
    }
}
