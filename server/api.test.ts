/**
 * End-to-end tests of the Worker's cloud-backup API (server/api.ts) against an
 * in-memory SQLite database standing in for D1, with Google's OAuth endpoints
 * mocked (a locally generated RSA key signs the ID tokens).
 * Skipped where node:sqlite is unavailable (Node < 22.5).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { handleApi, scheduledCleanup, type ApiEnv } from './api';

type SqliteModule = typeof import('node:sqlite');
const sqlite: SqliteModule | null = await import('node:sqlite').catch(() => null);

/** Just enough of the D1 API for server/api.ts. */
function fakeD1(db: InstanceType<SqliteModule['DatabaseSync']>): D1Database {
    const exec = (sql: string, params: unknown[]) => {
        const stmt = db.prepare(sql);
        const args = params.map(p => (p === undefined ? null : p)) as (string | number | null)[];
        if (/^\s*select\b|\breturning\b/i.test(sql)) {
            const results = stmt.all(...args).map(r => ({ ...r }));
            return { success: true, results, meta: { changes: results.length, last_row_id: 0 } };
        }
        const info = stmt.run(...args);
        return { success: true, results: [], meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) } };
    };
    const statement = (sql: string, params: unknown[] = []): any => ({
        bind: (...p: unknown[]) => statement(sql, p),
        run: async () => exec(sql, params),
        all: async () => exec(sql, params),
        first: async () => exec(sql, params).results[0] ?? null,
        __exec: () => exec(sql, params),
    });
    return {
        prepare: (sql: string) => statement(sql),
        batch: async (stmts: any[]) => {
            db.exec('BEGIN');
            try {
                const out = stmts.map(s => s.__exec());
                db.exec('COMMIT');
                return out;
            } catch (e) {
                db.exec('ROLLBACK');
                throw e;
            }
        },
    } as unknown as D1Database;
}

const CLIENT_ID = 'test-client.apps.googleusercontent.com';
const enc = new TextEncoder();
const b64url = (b: Uint8Array) => Buffer.from(b).toString('base64url');

describe.skipIf(!sqlite)('cloud-backup API (D1)', () => {
    let env: ApiEnv;
    let keys: CryptoKeyPair;
    let jwk: JsonWebKey & { kid: string };
    const google = { sub: 'sub-alice', badSignature: false, tokenBody: null as URLSearchParams | null };

    const signIdToken = async (claims: Record<string, unknown>) => {
        const h = b64url(enc.encode(JSON.stringify({ alg: 'RS256', kid: 'k1' })));
        const p = b64url(enc.encode(JSON.stringify(claims)));
        const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', keys.privateKey, enc.encode(`${h}.${p}`)));
        if (google.badSignature) sig[0] ^= 1;
        return `${h}.${p}.${b64url(sig)}`;
    };

    beforeAll(async () => {
        env = {
            DB: fakeD1(new sqlite!.DatabaseSync(':memory:')),
            GOOGLE_CLIENT_ID: CLIENT_ID,
            GOOGLE_CLIENT_SECRET: 'secret',
        };
        keys = await crypto.subtle.generateKey(
            { name: 'RSASSA-PKCS1-v1_5', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
            true, ['sign', 'verify'],
        ) as CryptoKeyPair;
        jwk = { ...(await crypto.subtle.exportKey('jwk', keys.publicKey)), kid: 'k1' };
        vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input instanceof Request ? input.url : input);
            if (url === 'https://www.googleapis.com/oauth2/v3/certs') return Response.json({ keys: [jwk] });
            if (url === 'https://oauth2.googleapis.com/token') {
                google.tokenBody = new URLSearchParams(String(init?.body));
                if (google.tokenBody.get('code') !== 'good-code') return new Response('bad', { status: 400 });
                return Response.json({
                    id_token: await signIdToken({
                        iss: 'https://accounts.google.com', aud: CLIENT_ID, sub: google.sub,
                        exp: Math.floor(Date.now() / 1000) + 600,
                    }),
                });
            }
            throw new Error(`unexpected fetch ${url}`);
        });
    });
    afterAll(() => { vi.unstubAllGlobals(); });

    const call = async (method: string, path: string, body?: unknown, token?: string) => {
        const res = await handleApi(new Request(`http://localhost/api${path}`, {
            method,
            headers: {
                ...(body ? { 'Content-Type': 'application/json' } : {}),
                ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: body ? JSON.stringify(body) : undefined,
        }), env);
        return { status: res.status, headers: res.headers, body: await res.json() as any };
    };
    const googleLogin = async () => {
        const start = await call('GET', '/auth/oidc/authorize');
        return call('POST', '/auth/oidc/callback', { code: 'good-code', state: start.body.data.state });
    };
    /** Signs in as a (new) Google user and returns an access token. */
    const signIn = async (sub: string) => {
        google.sub = sub;
        return (await googleLogin()).body.data.tokens.access_token as string;
    };

    describe('snapshot revisions', () => {
        it('accepts uploads based on the current revision and refuses stale ones', async () => {
            const token = await signIn('sub-occ');
            const empty = await call('POST', '/user/data', {}, token);
            expect(empty.body.data).toMatchObject({ data: null, revision: 0 });
            expect(empty.headers.get('X-Content-Type-Options')).toBe('nosniff');

            expect((await call('PUT', '/user/data', { data: { events: [1] }, base_revision: 0 }, token)).body.data.revision).toBe(1);
            expect((await call('PUT', '/user/data', { data: { events: [2] }, base_revision: 1 }, token)).body.data.revision).toBe(2);
            const stale = await call('PUT', '/user/data', { data: { events: [3] }, base_revision: 1 }, token);
            expect(stale.status).toBe(409);
            expect(stale.body.data.revision).toBe(2);
            const after = await call('POST', '/user/data', {}, token);
            expect(after.body.data).toMatchObject({ data: { events: [2] }, revision: 2 });
            expect((await call('GET', '/user/data/revision', undefined, token)).body.data.revision).toBe(2);
            // No base revision = explicit "keep this device's copy".
            expect((await call('PUT', '/user/data', { data: { events: [4] } }, token)).body.data.revision).toBe(3);
        });

        it('rate limits uploads', async () => {
            const token = await signIn('sub-busy');
            let last;
            for (let i = 0; i < 31; i++) last = await call('PUT', '/user/data', { data: { events: [i] } }, token);
            expect(last!.status).toBe(429);
        });
    });

    describe('Google sign-in', () => {
        it('creates an account on first sign-in and reuses it after', async () => {
            google.sub = 'sub-alice';
            const start = await call('GET', '/auth/oidc/authorize');
            const url = new URL(start.body.data.auth_url);
            expect(url.origin).toBe('https://accounts.google.com');
            expect(url.searchParams.get('scope')).toBe('openid');
            expect(url.searchParams.get('code_challenge_method')).toBe('S256');
            expect(url.searchParams.get('redirect_uri')).toBe('http://localhost/auth/oidc/callback');

            const first = await call('POST', '/auth/oidc/callback', { code: 'good-code', state: start.body.data.state });
            expect(first.body.data.is_new_user).toBe(true);
            expect(first.body.data.username).toMatch(/^google_/);
            expect(google.tokenBody?.get('code_verifier')?.length).toBeGreaterThan(40);
            // The authorization is single use.
            expect((await call('POST', '/auth/oidc/callback', { code: 'good-code', state: start.body.data.state })).status).toBe(400);

            const again = await googleLogin();
            expect(again.body.data).toMatchObject({ is_new_user: false, username: first.body.data.username });
            const token = again.body.data.tokens.access_token;
            expect((await call('GET', '/user/me', undefined, token)).body.data.has_password).toBe(false);
            expect((await call('DELETE', '/auth/sessions', {}, token)).body.data.revoked_count).toBe(1);

            google.sub = 'sub-bob';
            expect((await googleLogin()).body.data.username).not.toBe(first.body.data.username);
        });

        it('has no username/password accounts', async () => {
            const token = await signIn('sub-alice');
            expect((await call('POST', '/auth/register', { username: 'someone', password: 'abc12345' })).status).toBe(410);
            expect((await call('POST', '/auth/login', { username: 'someone', password: 'abc12345' })).status).toBe(410);
            expect((await call('POST', '/user/password', { password: 'abc12345' }, token)).status).toBe(410);
            expect((await call('GET', '/auth/oidc/bind/status', undefined, token)).status).toBe(410);
        });

        it('honours closed registration for new Google accounts only', async () => {
            const closed = { ...env, REGISTRATION_DISABLED: 'true' };
            const signInWith = async (sub: string) => {
                google.sub = sub;
                const start = await handleApi(new Request('http://localhost/api/auth/oidc/authorize'), closed);
                const { state } = ((await start.json()) as any).data;
                return handleApi(new Request('http://localhost/api/auth/oidc/callback', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ code: 'good-code', state }),
                }), closed);
            };
            expect((await signInWith('sub-alice')).status).toBe(200);
            expect((await signInWith('sub-newcomer')).status).toBe(403);
        });

        it('rejects forged tokens and bad codes', async () => {
            google.badSignature = true;
            expect((await googleLogin()).status).toBe(401);
            google.badSignature = false;
            const start = await call('GET', '/auth/oidc/authorize');
            expect((await call('POST', '/auth/oidc/callback', { code: 'nope', state: start.body.data.state })).status).toBe(401);
        });

        it('is off without credentials', async () => {
            const off = { ...env, GOOGLE_CLIENT_ID: undefined };
            const res = await handleApi(new Request('http://localhost/api/auth/oidc/config'), off);
            expect(((await res.json()) as any).data.oidc_enabled).toBe(false);
            expect((await handleApi(new Request('http://localhost/api/auth/oidc/authorize'), off)).status).toBe(503);
        });
    });

    it('daily cleanup runs', async () => {
        await expect(scheduledCleanup(env)).resolves.toBeUndefined();
    });
});
