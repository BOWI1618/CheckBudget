import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // В разработке фронт и API живут на разных портах. Прокси избавляет
      // от CORS и, что важнее, делает refresh-cookie same-origin — как в проде.
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/ws': { target: 'ws://localhost:3001', ws: true },
    },
  },
  build: { target: 'es2022', sourcemap: true },
});
