/**
 * WebAuthn passkeys as a way to unlock the cloud copy (fingerprint, face,
 * Windows Hello), ported from AtDo's client/vault/passkey.ts.
 *
 * Only the PRF extension matters: the authenticator turns a per-passkey input
 * into a fixed secret after user verification, and the server wraps the data
 * key with it (server/keys.ts). No server-side WebAuthn signature check is
 * needed: opening the envelope proves the authenticator was there, and the
 * account session still guards every request.
 */

const RP_NAME = 'AtDo Dose';
const USER_NAME = 'AtDo Dose';

/** The user closed the prompt, or verification failed / timed out. */
export class PasskeyCancelledError extends Error {}
/** The authenticator cannot provide the PRF output needed to unlock. */
export class PasskeyUnsupportedError extends Error {}

export interface PasskeySecret {
  credentialId: string;
  /** Standard base64, as the server expects. */
  prfOutput: string;
}

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

export const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (value: string) => Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
const fromBase64Url = (value: string) =>
  fromBase64(value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '='));

/** A fresh PRF input for a new passkey (stored by the server, base64). */
export const newPrfInput = () => toBase64(random(32));

/**
 * Whether this browser can do WebAuthn at all; PRF support is only certain
 * when creating. Browsers with getClientCapabilities (Chrome 133+, Safari 18+)
 * answer for PRF up front, so an explicit "no" hides the option.
 */
export async function canUsePasskeys(): Promise<boolean> {
  if (typeof PublicKeyCredential === 'undefined' || !navigator.credentials) return false;
  const capabilities = await (
    PublicKeyCredential as unknown as { getClientCapabilities?: () => Promise<Record<string, boolean>> }
  ).getClientCapabilities?.().catch(() => undefined);
  return capabilities?.['extension:prf'] !== false;
}

function cancelled(err: unknown): never {
  if (err instanceof DOMException && (err.name === 'NotAllowedError' || err.name === 'AbortError')) {
    throw new PasskeyCancelledError('cancelled');
  }
  throw err;
}

type PrfResults = { enabled?: boolean; results?: { first?: BufferSource } };
const prfOf = (credential: PublicKeyCredential) =>
  (credential.getClientExtensionResults() as { prf?: PrfResults }).prf;

const bytesOf = (source: BufferSource) =>
  source instanceof ArrayBuffer ? new Uint8Array(source) : new Uint8Array(source.buffer, source.byteOffset, source.byteLength);

/** Ask the authenticator to drop a passkey the server no longer knows (Chrome 132+; ignored elsewhere). */
export function forgetPasskey(credentialId: string) {
  const signal = (PublicKeyCredential as unknown as {
    signalUnknownCredential?: (options: { rpId: string; credentialId: string }) => Promise<void>;
  }).signalUnknownCredential;
  void signal?.({ rpId: location.hostname, credentialId }).catch(() => {});
}

/**
 * Create a passkey and get its PRF output for `prfInput`. Some authenticators
 * return it at creation, others only on a following assertion (a second prompt).
 */
export async function createPasskey(prfInput: string): Promise<PasskeySecret> {
  let credential: PublicKeyCredential;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        rp: { name: RP_NAME, id: location.hostname },
        // A new user id every time: adding another passkey on the same device
        // must not silently replace the previous one (its envelope would be lost).
        user: { id: random(16), name: USER_NAME, displayName: USER_NAME },
        challenge: random(32),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { residentKey: 'preferred', userVerification: 'required' },
        extensions: { prf: { eval: { first: fromBase64(prfInput) } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (err) {
    cancelled(err);
  }
  const prf = prfOf(credential);
  if (!prf?.enabled) {
    forgetPasskey(credential.id);
    throw new PasskeyUnsupportedError('PRF not supported');
  }
  if (prf.results?.first) return { credentialId: credential.id, prfOutput: toBase64(bytesOf(prf.results.first)) };
  return getPasskeySecret([{ credentialId: credential.id, prfInput }]);
}

/** Verify with any of these passkeys and return its PRF output. */
export async function getPasskeySecret(candidates: { credentialId: string; prfInput: string }[]): Promise<PasskeySecret> {
  let assertion: PublicKeyCredential;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: random(32),
        rpId: location.hostname,
        userVerification: 'required',
        allowCredentials: candidates.map((c) => ({ type: 'public-key' as const, id: fromBase64Url(c.credentialId) })),
        extensions: {
          prf: { evalByCredential: Object.fromEntries(candidates.map((c) => [c.credentialId, { first: fromBase64(c.prfInput) }])) },
        } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential;
  } catch (err) {
    cancelled(err);
  }
  const output = prfOf(assertion)?.results?.first;
  if (!output) throw new PasskeyUnsupportedError('no PRF output');
  return { credentialId: assertion.id, prfOutput: toBase64(bytesOf(output)) };
}
