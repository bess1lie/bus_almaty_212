import { defineConfig } from 'vite';

export default defineConfig({
  base: '/bus_almaty_212/',
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'esbuild',
  },
  server: {
    port: 5173,
    open: true,
  },
});
