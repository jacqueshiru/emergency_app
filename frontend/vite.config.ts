import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const hostedApiOrigin =
    env.VITE_HOSTED_API_URL || env.VITE_API_URL || 'https://emergency-app-48rd.onrender.com';

  return {
    plugins: [react()],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
      },
    },
    server: {
      port: 5173,
      proxy: {
        '/api': {
          target: 'http://localhost:5000',
          changeOrigin: true,
        },
        '/hosted-api': {
          target: hostedApiOrigin,
          changeOrigin: true,
          rewrite: (requestPath) => requestPath.replace(/^\/hosted-api/, '/api'),
        },
        '/socket.io': {
          target: 'http://localhost:5000',
          ws: true,
        },
      },
    },
  };
});
