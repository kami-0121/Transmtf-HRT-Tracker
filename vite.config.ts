import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import pkg from './package.json';

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, '.', '');
    return {
      // Single source for the version shown in Settings: package.json
      // (scripts/set_version.py keeps Tauri in step).
      define: {
        __APP_VERSION__: JSON.stringify(pkg.version),
      },
      server: {
        port: 3000,
        host: '0.0.0.0',
      },
      plugins: [
        react(),
        VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['favicon.ico', 'icon.svg'],
          manifest: {
            name: 'AtDo HRT',
            short_name: 'AtDo HRT',
            description: 'Track your HRT dosage and simulate E2 levels',
            theme_color: '#ffffff',
            background_color: '#ffffff',
            display: 'standalone',
            orientation: 'portrait',
            icons: [
              {
                src: 'favicon.ico',
                sizes: '64x64 32x32 24x24 16x16',
                type: 'image/x-icon',
                purpose: 'any'
              },
              {
                src: 'icon.svg',
                sizes: 'any',
                type: 'image/svg+xml',
                purpose: 'any maskable'
              }
            ]
          },
          workbox: {
            // Tailwind CSS is built locally (tailwind.config.js + postcss.config.js);
            // the old third-party CDN runtime cache was removed with the CDN script.
            // The cloud-backup API lives on the same origin: never answer it from
            // the app shell / cache.
            navigateFallbackDenylist: [/^\/api\//],
          }
        })
      ],
      resolve: {
        alias: {
          '@': path.resolve(__dirname, '.'),
        }
      }
    };
});
