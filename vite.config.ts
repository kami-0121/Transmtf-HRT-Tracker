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
          includeAssets: ['favicon.ico', 'icon.svg', 'apple-touch-icon-180x180.png'],
          manifest: {
            // The installed app is "AtDo Dose" (a discreet name on the home
            // screen, in the AtDo family); the pages inside say AtDo HRT.
            name: 'AtDo Dose',
            short_name: 'AtDo Dose',
            description: 'Track your medication doses and simulate levels',
            theme_color: '#ffffff',
            background_color: '#f6f7f3',
            display: 'standalone',
            orientation: 'portrait',
            icons: [
              { src: 'pwa-64x64.png', sizes: '64x64', type: 'image/png' },
              { src: 'pwa-192x192.png', sizes: '192x192', type: 'image/png' },
              { src: 'pwa-512x512.png', sizes: '512x512', type: 'image/png' },
              { src: 'maskable-icon-512x512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
              { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml' },
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
