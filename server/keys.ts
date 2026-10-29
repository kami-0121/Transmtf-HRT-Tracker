/**
 * Key hierarchy for the PIN-protected cloud copy, after AtDo's vault
 * (client/vault/crypto.ts + session.ts), adapted to a server that encrypts:
 *
 *   PIN            → PBKDF2 → KEK ─┐
 *   recovery key   → HKDF   → KEK ─┼→ unwrap envelope → DEK (random, fixed) → AES-GCM → snapshot
 *   passkey (PRF)  → HKDF   → KEK ─┤
 *   device / session secret → HKDF ┘   (unlock tokens; device = "remember 7 days")
 *
 * Every way in is an envelope (key_envelopes) wrapping the same DEK, so
 * changing the PIN or adding a passkey never re-encrypts the data. The server
 * stores only wrapped keys; the secrets that open them (PIN, recovery key,
 * PRF output, token secret) are sent by the client and never stored.
 *
 * Accounts that set their PIN before envelopes existed (key_version 1: the
 * snapshot was encrypted directly with the PIN key) are upgraded on the first
 * successful PIN unlock.
 */
import {
    toB64, fromB64, randomBytes, randomToken, pinKey, aesEncrypt, aesDecrypt, utf8,
} from './crypto';

export const PIN_ITERATIONS = 10_000;
export const PIN_CHECK_TEXT = 'hrt-tracker-pin-check-v1';
export const PIN_RE = /^\d{6}$/;
/** Unlock without the PIN on this device for 7 days, never extended (as AtDo). */
export const DEVICE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
/** Unlock for this browser session only (token kept in memory). */
export const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const TOKEN_PREFIX = 'u1.';

export type EnvelopeKind = 'pin' | 'recovery' | 'passkey' | 'device' | 'session';

export interface EnvelopeRow {
    id: string;
    user_id: number;
    kind: EnvelopeKind;
    wrapped: string;
    credential_id: string | null;
    prf_input: string | null;
    label: string | null;
    created_at: string;
    expires_at: number | null;
}

/** The data key in both forms: raw (to wrap new envelopes) and usable. */
export interface DataKey {
    raw: Uint8Array;
    key: CryptoKey;
}

export const importDek = async (raw: Uint8Array): Promise<DataKey> => ({
    raw,
    key: await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']),
});

export const newDek = () => importDek(randomBytes(32));

/** KEK from a high-entropy secret (recovery key, PRF output, token secret). */
export async function hkdfKek(secret: Uint8Array, info: string): Promise<CryptoKey> {
    const base = await crypto.subtle.importKey('raw', secret, 'HKDF', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
        { name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: utf8(`atdo-dose:${info}`) },
        base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'],
    );
}

export const pinKek = (pin: string, salt: string) => pinKey(pin, fromB64(salt), PIN_ITERATIONS);

export const wrapDek = async (kek: CryptoKey, dek: DataKey) => toB64(await aesEncrypt(kek, dek.raw));

/** Throws when the KEK is wrong (AES-GCM tag mismatch). */
export const unwrapDek = async (kek: CryptoKey, wrapped: string) => importDek(await aesDecrypt(kek, fromB64(wrapped)));

// ── recovery keys ────────────────────────────────────────────────────────────

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** 160 random bits as 32 Crockford base32 characters, grouped by 4. */
export function newRecoveryKey(): string {
    const bytes = randomBytes(20);
    let bits = 0, value = 0, out = '';
    for (const b of bytes) {
        value = (value << 8) | b;
        bits += 8;
        while (bits >= 5) {
            out += CROCKFORD[(value >>> (bits - 5)) & 31];
            bits -= 5;
        }
    }
    return out.match(/.{4}/g)!.join('-');
}

/** Canonical form (case, separators and look-alike letters forgiven); null if malformed. */
export function normalizeRecoveryKey(input: string): string | null {
    const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
    return /^[0-9A-HJKMNP-TV-Z]{32}$/.test(clean) ? clean : null;
}

export const recoveryKek = (canonical: string) => hkdfKek(utf8(canonical), 'recovery');

// ── unlock tokens ────────────────────────────────────────────────────────────

export interface IssuedToken {
    id: string;
    secret: string;
    token: string;
    wrapped: string;
    expiresAt: number;
}

/** A device/session envelope: the token is its id plus the secret that opens it. */
export async function issueToken(dek: DataKey, ttlMs: number): Promise<IssuedToken> {
    const id = randomToken(12);
    const secret = randomToken(32);
    const wrapped = await wrapDek(await hkdfKek(utf8(secret), 'device'), dek);
    return { id, secret, token: `${TOKEN_PREFIX}${id}.${secret}`, wrapped, expiresAt: Date.now() + ttlMs };
}

export function parseToken(value: string): { id: string; secret: string } | null {
    if (!value.startsWith(TOKEN_PREFIX)) return null;
    const [id, secret] = value.slice(TOKEN_PREFIX.length).split('.');
    return id && secret && /^[A-Za-z0-9_-]+$/.test(id + secret) ? { id, secret } : null;
}

export const tokenKek = (secret: string) => hkdfKek(utf8(secret), 'device');

export const passkeyKek = (prfOutputB64: string) => hkdfKek(fromB64(prfOutputB64), 'passkey');

