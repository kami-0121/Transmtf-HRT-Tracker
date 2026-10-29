/**
 * Google sign-in (OAuth 2.0 authorization code + PKCE), after AtDo's
 * src/api/google.ts. Scopes `openid profile`: a stable user id plus the Google
 * name and photo, used as the account's default display name and avatar (both
 * editable). No e-mail address is requested.
 *
 * Google is the only way to sign in on this backend. The flow fits the
 * frontend's existing OIDC pages (Login / OIDCCallback):
 *   GET  /api/auth/oidc/authorize   → { auth_url, state }
 *   POST /api/auth/oidc/callback    { code, state } → tokens (first sign-in creates the account)
 * The PKCE verifier stays on the server (oauth_states, 10 min, single use);
 * the browser only keeps `state` to match the redirect.
 */
import { randomToken, sha256Hex, utf8 } from './crypto';

export const GOOGLE_CALLBACK_PATH = '/auth/oidc/callback';
const AUTHORIZE_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const GOOGLE_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
const JWKS_TTL_MS = 60 * 60 * 1000;

export interface GoogleEnv {
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
}

export const googleEnabled = (env: GoogleEnv) => !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET);

const b64url = (bytes: Uint8Array) =>
    btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = (s: string) => {
    const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
    return Uint8Array.from(b, c => c.charCodeAt(0));
};

export const redirectUri = (origin: string) => new URL(GOOGLE_CALLBACK_PATH, origin).href;

/** Builds the authorization URL; the caller stores `state` → `verifier`. */
export async function buildAuthorizeUrl(env: GoogleEnv, origin: string) {
    const state = randomToken();
    const verifier = randomToken();
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(verifier))));
    const url = new URL(AUTHORIZE_URL);
    url.search = new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID!,
        redirect_uri: redirectUri(origin),
        response_type: 'code',
        scope: 'openid profile',
        state,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        prompt: 'select_account',
    }).toString();
    return { authUrl: url.href, state, verifier };
}

// Google's signing keys, cached per isolate.
let jwks: { at: number; keys: Map<string, JsonWebKey> } | null = null;
async function signingKey(kid: string): Promise<JsonWebKey | undefined> {
    if (!jwks || Date.now() - jwks.at > JWKS_TTL_MS || !jwks.keys.has(kid)) {
        const res = await fetch(JWKS_URL);
        if (!res.ok) throw new Error(`jwks ${res.status}`);
        const body = await res.json<{ keys: (JsonWebKey & { kid: string })[] }>();
        jwks = { at: Date.now(), keys: new Map(body.keys.map(k => [k.kid, k])) };
    }
    return jwks.keys.get(kid);
}

export interface GoogleIdentity {
    sub: string;
    name?: string;
    picture?: string;
}

/** Verifies an RS256 Google ID token; returns the identity claims. */
export async function verifyIdToken(idToken: string, clientId: string): Promise<GoogleIdentity> {
    const [h, p, sig] = idToken.split('.');
    if (!h || !p || !sig) throw new Error('malformed id_token');
    const header = JSON.parse(new TextDecoder().decode(fromB64url(h))) as { alg?: string; kid?: string };
    if (header.alg !== 'RS256' || !header.kid) throw new Error('unexpected id_token header');
    const jwk = await signingKey(header.kid);
    if (!jwk) throw new Error('unknown signing key');
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(sig), utf8(`${h}.${p}`));
    if (!valid) throw new Error('bad id_token signature');
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(p))) as {
        iss?: string; aud?: string | string[]; exp?: number; sub?: string; name?: unknown; picture?: unknown;
    };
    const audOk = Array.isArray(claims.aud) ? claims.aud.includes(clientId) : claims.aud === clientId;
    if (!claims.iss || !GOOGLE_ISSUERS.includes(claims.iss)) throw new Error('bad issuer');
    if (!audOk) throw new Error('bad audience');
    if (!claims.exp || claims.exp * 1000 < Date.now() - 60_000) throw new Error('id_token expired');
    if (!claims.sub) throw new Error('id_token without sub');
    return {
        sub: claims.sub,
        name: typeof claims.name === 'string' ? claims.name : undefined,
        // Only Google's own image host, so the avatar can never point elsewhere.
        picture: typeof claims.picture === 'string' && /^https:\/\/[a-z0-9.-]+\.googleusercontent\.com\//.test(claims.picture)
            ? claims.picture : undefined,
    };
}

/** Exchanges the authorization code; returns the verified Google identity. */
export async function exchangeCode(env: GoogleEnv, origin: string, code: string, verifier: string): Promise<GoogleIdentity> {
    const res = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            code,
            client_id: env.GOOGLE_CLIENT_ID!,
            client_secret: env.GOOGLE_CLIENT_SECRET!,
            redirect_uri: redirectUri(origin),
            grant_type: 'authorization_code',
            code_verifier: verifier,
        }),
    });
    if (!res.ok) throw new Error(`token endpoint ${res.status}`);
    const { id_token: idToken } = await res.json<{ id_token?: string }>();
    if (!idToken) throw new Error('no id_token');
    return verifyIdToken(idToken, env.GOOGLE_CLIENT_ID!);
}

/** Stored form of a Google identity: the raw subject never reaches D1. */
export const subjectHash = (sub: string) => sha256Hex(`google:${sub}`);
