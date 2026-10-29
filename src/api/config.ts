// The cloud backup API is served by this app's own Worker (server/api.ts, D1)
// at /api on the same origin unless another backend is configured.
const DEFAULT_API_BASE_URL = typeof location !== 'undefined' && /^https?:$/.test(location.protocol)
  ? `${location.origin}/api`
  : '/api';
// No fallback Turnstile key: the original project's key only works on its own
// domains. Empty = no CAPTCHA step (the backend only enforces Turnstile when
// TURNSTILE_SECRET_KEY is configured).
const FALLBACK_TURNSTILE_SITE_KEY = '';

type RuntimeEnv = {
  VITE_API_BASE_URL?: string;
  VITE_TURNSTILE_SITE_KEY?: string;
  __ENV__?: {
    VITE_API_BASE_URL?: string;
    VITE_TURNSTILE_SITE_KEY?: string;
    CLOUD_ENABLED?: string;
    CLOUD_BACKEND?: string;
  };
};

const runtimeEnv = globalThis as RuntimeEnv;

export const API_BASE_URL =
  runtimeEnv.__ENV__?.VITE_API_BASE_URL ||
  runtimeEnv.VITE_API_BASE_URL ||
  import.meta.env.VITE_API_BASE_URL ||
  DEFAULT_API_BASE_URL;

export const API_ORIGIN = API_BASE_URL.replace(/\/api\/?$/, '');

/**
 * Accounts, cloud sync, sharing, announcements and usage statistics all talk
 * to a backend. They are OFF unless explicitly enabled — at runtime by the
 * Cloudflare Worker (`CLOUD_ENABLED` var → window.__ENV__) or at build time
 * (`VITE_CLOUD_ENABLED=true`). Off = local-only app: no request leaves the
 * browser and data stays in localStorage.
 */
const cloudFlag = runtimeEnv.__ENV__?.CLOUD_ENABLED ?? import.meta.env.VITE_CLOUD_ENABLED;
export const CLOUD_ENABLED = String(cloudFlag ?? '').toLowerCase() === 'true';

/**
 * 'd1' = this repo's own Worker backend (accounts, devices, security PIN,
 * cloud backup only — no shares / avatars / OIDC); 'external' = a full
 * backend compatible with the original project's API.
 */
export const CLOUD_BACKEND: 'd1' | 'external' =
  (runtimeEnv.__ENV__?.CLOUD_BACKEND ?? (import.meta.env.VITE_API_BASE_URL ? 'external' : 'd1')) === 'external' ? 'external' : 'd1';

export const TURNSTILE_SITE_KEY =
  runtimeEnv.__ENV__?.VITE_TURNSTILE_SITE_KEY ||
  runtimeEnv.VITE_TURNSTILE_SITE_KEY ||
  import.meta.env.VITE_TURNSTILE_SITE_KEY ||
  FALLBACK_TURNSTILE_SITE_KEY;

// Log configuration for debugging (only in development)
if (import.meta.env.DEV) {
  console.log('[Config] API_BASE_URL:', API_BASE_URL);
  console.log('[Config] API_BASE_URL Protocol:', API_BASE_URL.startsWith('https://') ? 'HTTPS ✓' : 'HTTP ✗');
  console.log('[Config] TURNSTILE_SITE_KEY:', TURNSTILE_SITE_KEY ? 'Configured' : 'Missing');
  console.log('[Config] Source:',
    runtimeEnv.__ENV__?.VITE_API_BASE_URL ? 'window.__ENV__' :
    runtimeEnv.VITE_API_BASE_URL ? 'globalThis' :
    import.meta.env.VITE_API_BASE_URL ? 'import.meta.env' :
    'Fallback hardcoded');
}
