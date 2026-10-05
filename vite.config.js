import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));

function copySharedStyles() {
  return {
    name: 'copy-shared-styles',
    closeBundle() {
      const outDir = path.join(root, 'dist', 'css');
      fs.mkdirSync(outDir, { recursive: true });
      for (const file of ['fonts.css', 'tokens.css', 'document.css']) {
        fs.copyFileSync(path.join(root, 'src', 'styles', file), path.join(outDir, file));
      }
    }
  };
}

export default defineConfig({
  plugins: [react(), copySharedStyles()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:4001',
      '/print': 'http://localhost:4001'
    }
  },
  build: {
    outDir: 'dist'
  }
});
