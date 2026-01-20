import { defineConfig } from 'vite';
import { resolve } from 'path';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  root: 'src',
  envDir: resolve(__dirname, '..'),
  publicDir: '../public',
  plugins: [
    tailwindcss(),
  ],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, 'src/index.html'),
        analysis: resolve(__dirname, 'src/analysis.html'),
      },
    },
  },
  server: {
    port: 3000,
  },
});
