/// <reference types="vitest/config" />
import { defineConfig, type Plugin } from 'vite';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const wasmDir = resolve(root, 'node_modules/@mediapipe/tasks-vision/wasm');

// Only the ES-module flavour of the MediaPipe runtime is needed: it is loaded with
// a dynamic import() both inside the segmentation worker and on the main thread.
const WASM_FILES = ['vision_wasm_module_internal.js', 'vision_wasm_module_internal.wasm'];

/**
 * Serves the MediaPipe Tasks Vision wasm runtime from node_modules under
 * `/mediapipe/` during development and copies it into the build output, so the
 * app never depends on a CDN at runtime.
 */
function mediapipeWasm(): Plugin {
  return {
    name: 'ames-mediapipe-wasm',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.split('?')[0] ?? '';
        const match = /\/mediapipe\/([\w.-]+)$/.exec(url);
        if (!match || !WASM_FILES.includes(match[1])) return next();
        const file = join(wasmDir, match[1]);
        if (!existsSync(file)) return next();
        res.setHeader('Content-Type', file.endsWith('.wasm') ? 'application/wasm' : 'text/javascript');
        res.setHeader('Content-Length', statSync(file).size);
        res.setHeader('Cache-Control', 'no-cache');
        createReadStream(file).pipe(res);
      });
    },
    generateBundle() {
      for (const name of WASM_FILES) {
        this.emitFile({ type: 'asset', fileName: `mediapipe/${name}`, source: readFileSync(join(wasmDir, name)) });
      }
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [mediapipeWasm()],
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 1500,
  },
  server: { host: true },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
  },
});
