import path from 'path';
import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(({ mode }) => {
  // 루트(index.html 위치)를 기준으로 env 로드
  const root = path.resolve(__dirname, '../..');
  const env  = loadEnv(mode, root, '');
  return {
    base: './',
    root,
    // index.html은 루트에 있음
    publicDir: path.resolve(root, 'public'),
    server: { port: 3000, host: '0.0.0.0' },
    plugins: [react()],
    define: {
      '__FIREBASE_API_KEY__': JSON.stringify(env.VITE_FIREBASE_API_KEY ?? ''),
    },
    resolve: {
      alias: { '@': path.resolve(root, 'src') },
    },
    build: {
      outDir: path.resolve(root, 'dist'),
      emptyOutDir: true,
    },
  };
});
