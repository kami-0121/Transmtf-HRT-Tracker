/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
    readonly VITE_API_BASE_URL?: string;
    readonly VITE_TURNSTILE_SITE_KEY?: string;
    /** "true" enables accounts / cloud sync at build time (see src/api/config.ts). */
    readonly VITE_CLOUD_ENABLED?: string;
}
