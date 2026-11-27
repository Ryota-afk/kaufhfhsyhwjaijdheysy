import { defineConfig } from 'vite';
import { cpSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// GitHub Pages ではリポジトリ名の下に置かれる。
export default defineConfig({
  base: '/kaufhfhsyhwjaijdheysy/',
  build: {
    outDir: 'dist', emptyOutDir: true,
    rollupOptions: { input: { main: resolve(__dirname, 'index.html'), bench: resolve(__dirname, 'bench.html'), party: resolve(__dirname, 'party.html'), battle: resolve(__dirname, 'battle.html') } },
  },
  worker: { format: 'es' },
  resolve: { alias: { '@showdown-full': resolve(__dirname, '.build/showdown-full.mjs'), '@showdown': resolve(__dirname, '.build/showdown-browser.mjs') } },
  plugins: [
    {
      // data/ をそのまま公開用の出力に写す（サイトから読み出すため）。
      name: 'copy-data',
      closeBundle() {
        cpSync(resolve(__dirname, 'data'), resolve(__dirname, 'dist/data'), { recursive: true });
        // リポジトリにあるパーティの一覧（画面から「読み込む」に使う）
        const files = readdirSync(resolve(__dirname, 'data/parties')).filter(f => f.endsWith('.json') && f !== 'index.json');
        writeFileSync(resolve(__dirname, 'dist/data/parties/index.json'), JSON.stringify({ files }));
      },
    },
  ],
});
