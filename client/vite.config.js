import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API_PORT = process.env.PORT || 4000;

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1', // localhost only — never exposed on the network by default
    port: 5173,
    strictPort: true,
    proxy: { '/api': { target: `http://127.0.0.1:${API_PORT}`, changeOrigin: false } },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.js'],
    globals: true,
  },
});
