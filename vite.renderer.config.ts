import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

const host = process.env.TAURI_DEV_HOST;

export default defineConfig(({ mode }) => {
  const supportSettingsEnabled =
    process.env.CSN_SUPPORT_SETTINGS === undefined
      ? mode !== 'production'
      : ['1', 'true', 'yes', 'on'].includes(process.env.CSN_SUPPORT_SETTINGS.toLowerCase());

  return {
    plugins: [react()],
    clearScreen: false,
    define: {
      __APP_UPDATE_BASE_URL__: JSON.stringify(process.env.APP_UPDATE_BASE_URL ?? ''),
      // Public OAuth coordinates, not secrets. Empty ships an ungated build.
      __CLERK_OAUTH_ISSUER__: JSON.stringify(process.env.CLERK_OAUTH_ISSUER ?? ''),
      __CLERK_OAUTH_CLIENT_ID__: JSON.stringify(process.env.CLERK_OAUTH_CLIENT_ID ?? ''),
      // Where stations fetch short-lived storage credentials. Public.
      __CSN_BROKER_URL__: JSON.stringify(process.env.CSN_BROKER_URL ?? ''),
      __CSN_B2_BUCKET__: JSON.stringify(process.env.CSN_B2_BUCKET ?? ''),
      __CSN_B2_PATH_PREFIX__: JSON.stringify(process.env.CSN_B2_PATH_PREFIX ?? 'vod/archive'),
      __CSN_B2_S3_ENDPOINT__: JSON.stringify(process.env.CSN_B2_S3_ENDPOINT ?? ''),
      __CSN_R2_ACCOUNT_ID__: JSON.stringify(process.env.CSN_R2_ACCOUNT_ID ?? ''),
      __CSN_R2_BUCKET__: JSON.stringify(process.env.CSN_R2_BUCKET ?? ''),
      __CSN_R2_PATH_PREFIX__: JSON.stringify(process.env.CSN_R2_PATH_PREFIX ?? 'vod/hls'),
      __CSN_R2_PUBLIC_BASE_URL__: JSON.stringify(process.env.CSN_R2_PUBLIC_BASE_URL ?? ''),
      __CSN_CONVEX_DEPLOYMENT_URL__: JSON.stringify(process.env.CSN_CONVEX_DEPLOYMENT_URL ?? ''),
      __CSN_CONVEX_MUTATION_PATH__: JSON.stringify(
        process.env.CSN_CONVEX_MUTATION_PATH ?? 'media/videos:createVodEntry',
      ),
      __CSN_OFFLOAD_B2_PATH_PREFIX__: JSON.stringify(
        process.env.CSN_OFFLOAD_B2_PATH_PREFIX ?? 'offloads',
      ),
      __SUPPORT_SETTINGS_ENABLED__: JSON.stringify(supportSettingsEnabled),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      port: 1420,
      strictPort: true,
      host: host || '127.0.0.1',
      hmr: host
        ? {
            protocol: 'ws',
            host,
            port: 1421,
          }
        : undefined,
      watch: {
        ignored: ['**/src-tauri/**'],
      },
    },
    build: {
      target: process.env.TAURI_ENV_PLATFORM === 'windows' ? 'chrome105' : 'safari13',
      minify: !process.env.TAURI_ENV_DEBUG,
      sourcemap: Boolean(process.env.TAURI_ENV_DEBUG),
    },
  };
});
