/**
 * Crypto helpers for the Worker backend (Web Crypto only — runs in Workers and
 * in Node ≥ 18 for tests).
 */

const enc = new TextEncoder();
const dec = new TextDecoder();

export const toB64 = (bytes: Uint8Array): string => {
    let s = '';
    for (let i = 0; i < bytes.length; i += 0x8000) {
        s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    }
    return btoa(s);
};

export const fromB64 = (b64: string): Uint8Array => {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
};

export const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

/** URL-safe random token (256 bits by default). */
export const randomToken = (bytes = 32): string =>
    toB64(randomBytes(bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export const sha256Hex = async (text: string): Promise<string> => {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)));
    return Array.from(digest, b => b.toString(16).padStart(2, '0')).join('');
};

/** Constant-time comparison of equal-length byte arrays. */
export const timingSafeEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false;
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
    return diff === 0;
};

export const pbkdf2 = async (secret: string, salt: Uint8Array, iterations: number, bytes = 32): Promise<Uint8Array> => {
    const key = await crypto.subtle.importKey('raw', enc.encode(secret), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, bytes * 8);
    return new Uint8Array(bits);
};

/** AES-GCM-256 key derived from the 6-digit security PIN. */
export const pinKey = async (pin: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> => {
    const raw = await pbkdf2(pin, salt, iterations);
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
};

/** iv(12) ‖ ciphertext+tag */
export const aesEncrypt = async (key: CryptoKey, plain: Uint8Array): Promise<Uint8Array> => {
    const iv = randomBytes(12);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
    const out = new Uint8Array(12 + ct.length);
    out.set(iv, 0);
    out.set(ct, 12);
    return out;
};

/** Throws when the key is wrong (authentication tag mismatch). */
export const aesDecrypt = async (key: CryptoKey, blob: Uint8Array): Promise<Uint8Array> =>
    new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.subarray(0, 12) }, key, blob.subarray(12)));

const pipe = async (data: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> => {
    const out = new Response(new Blob([data]).stream().pipeThrough(stream));
    return new Uint8Array(await out.arrayBuffer());
};

export const gzip = (data: Uint8Array) => pipe(data, new CompressionStream('gzip'));
export const gunzip = (data: Uint8Array) => pipe(data, new DecompressionStream('gzip'));

export const encodeJson = (value: unknown): Uint8Array => enc.encode(JSON.stringify(value));
export const decodeJson = (bytes: Uint8Array): unknown => JSON.parse(dec.decode(bytes));
export const utf8 = (text: string): Uint8Array => enc.encode(text);
