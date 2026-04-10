import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  define: {
    __APP_UPDATE_BASE_URL__: JSON.stringify(process.env.APP_UPDATE_BASE_URL ?? ''),
  },
});
