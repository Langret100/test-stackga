import path from 'path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(() => {
  const root = path.resolve(__dirname, '../..');
  return {
    base: './',
    root,
    publicDir: path.resolve(root, 'public'),
    server: { port: 3000, host: '0.0.0.0' },
    plugins: [react()],
    resolve: {
      alias: { '@': path.resolve(root, 'src') },
    },
    build: {
      outDir: path.resolve(root, 'dist'),
      emptyOutDir: true,
    },
  };
});
