import { defineConfig } from 'vite';

export default defineConfig({
  // every module (incl. three/addons) must share the WebGPU build of three
  resolve: { alias: [{ find: /^three$/, replacement: 'three/webgpu' }] },
  base: './',
  build: { assetsDir: 'static', chunkSizeWarningLimit: 3000, target: 'es2022' },
  server: { port: 5173 },
});
