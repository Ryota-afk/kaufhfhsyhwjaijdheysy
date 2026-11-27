import { defineConfig } from 'vite';
import { cpSync } from 'node:fs';
import { resolve } from 'node:path';

// GitHub Pages ではリポジトリ名の下に置かれる。
export default defineConfig({
  base: '/kaufhfhsyhwjaijdheysy/',
  build: {
    outDir: 'dist', emptyOutDir: true,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), bench: resolve(__dirname, 'bench.html') } },
  },
  worker: { format: 'es' },
  resolve: { alias: { '@showdown': resolve(__dirname, '.build/showdown-browser.mjs') } },
  plugins: [
    {
      // data/ をそのまま公開用の出力に写す（サイトから読み出すため）。
      name: 'copy-data',
      closeBundle() {
        cpSync(resolve(__dirname, 'data'), resolve(__dirname, 'dist/data'), { recursive: true });
      },
    },
  ],
});
