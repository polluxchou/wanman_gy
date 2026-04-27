import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig(async ({ command }) => {
  const plugins = [react()];
  if (command === 'serve') {
    const bridgeModule = './dev-runtime-bridge.ts';
    const { wanmanRuntimeBridgePlugin } = await import(/* @vite-ignore */ bridgeModule);
    plugins.unshift(wanmanRuntimeBridgePlugin());
  }

  return {
    plugins,
    server: {
      host: '127.0.0.1',
      port: 5173,
    },
    build: {
      outDir: 'dist',
      sourcemap: true,
    },
  };
});
