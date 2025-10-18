import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { visualizer } from 'rollup-plugin-visualizer';
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

export default defineConfig({
  plugins: [vue(), tailwindcss(), visualizer()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '127.0.0.1'
  },
  envDir: '.',
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          if( id.includes('@lit-protocol') ) {
            return 'lit-protocol';
          }
          if( id.includes('@ethersproject') ) {
            return 'ethers';
          }
        },
        inlineDynamicImports: false,
        // Inline tiny chunks like the Vue export helper
        experimentalMinChunkSize: 1000
      }
    }
  },
  test: {
    environment: 'happy-dom',
    globals: true
  }
})
