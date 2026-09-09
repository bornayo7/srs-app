import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { VitePWA } from 'vite-plugin-pwa';
import { fileURLToPath, URL } from 'node:url';
import { realpathSync } from 'node:fs';

export default defineConfig({
  root: realpathSync(fileURLToPath(new URL('.', import.meta.url))),
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'SRS — Spaced Repetition',
        short_name: 'SRS',
        description: 'WaniKani-style spaced repetition for anything',
        theme_color: '#0f172a',
        background_color: '#0f172a',
        display: 'standalone',
        icons: [
          { src: 'icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,woff2,wasm}'],
      },
    }),
  ],
  resolve: {
    alias: { '@': realpathSync(fileURLToPath(new URL('./src', import.meta.url))) },
  },
  test: {
    environment: 'node',
    setupFiles: [realpathSync(fileURLToPath(new URL('./vitest.setup.ts', import.meta.url)))],
  },
});
