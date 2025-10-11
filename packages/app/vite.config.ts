import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { visualizer } from 'rollup-plugin-visualizer';

export default defineConfig({
  plugins: [vue(), visualizer()],
  server: {
    host: '127.0.0.1'
  },
  envDir: '.',
  test: {
    environment: 'happy-dom',
    globals: true
  }
})
