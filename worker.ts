import { handleApi, type ApiEnv } from './server/api';

export interface Env extends ApiEnv {
  ASSETS: Fetcher;
  VITE_API_BASE_URL?: string;
  VITE_TURNSTILE_SITE_KEY?: string;
  /** "true" enables accounts / cloud backup (needs the D1 binding "DB"). */
  CLOUD_ENABLED?: string;
}

const buildRuntimeEnvScript = (env: Env, origin: string) => {
  const runtimeEnv = {
    // Cloud backup is served by this same Worker (server/api.ts) unless an
    // external API is configured explicitly.
    VITE_API_BASE_URL: env.VITE_API_BASE_URL || `${origin}/api`,
    VITE_TURNSTILE_SITE_KEY: env.VITE_TURNSTILE_SITE_KEY || '',
    CLOUD_ENABLED: env.CLOUD_ENABLED ?? 'false',
    // Tells the UI which optional features exist (no shares / avatars / OIDC here).
    CLOUD_BACKEND: env.VITE_API_BASE_URL ? 'external' : 'd1',
  };

  return `<script>window.__ENV__=${JSON.stringify(runtimeEnv).replace(/</g, '\\u003c')};</script>`;
};

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
      if (env.CLOUD_ENABLED !== 'true') {
        return new Response(JSON.stringify({ success: false, error: 'Cloud backup is disabled' }), {
          status: 503,
          headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        });
      }
      return handleApi(request, env);
    }

    // Everything else: the static React app (SPA fallback via not_found_handling).
    const response = await env.ASSETS.fetch(request);
    const contentType = response.headers.get('content-type') || '';

    if (!contentType.includes('text/html')) {
      return response;
    }

    const runtimeEnvScript = buildRuntimeEnvScript(env, url.origin);
    return new HTMLRewriter()
      .on('head', {
        element(element) {
          // Inject runtime environment variables
          element.append(runtimeEnvScript, { html: true });
        }
      })
      .transform(response);
  },
};
