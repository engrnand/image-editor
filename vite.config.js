import { defineConfig } from 'vite';

export default defineConfig({
  server: { port: 5180, open: true },
  build: { target: 'es2020' },
});
