import { defineConfig, Plugin } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import { visualizer } from 'rollup-plugin-visualizer';
import { sri } from 'vite-plugin-sri3'
import tailwindcss from '@tailwindcss/vite';
import path from 'path';

// Custom plugin to inline CSS into HTML
function inlineCss(): Plugin {
  return {
    name: 'inline-css',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlFiles = Object.keys(bundle).filter(i => i.endsWith('.html'));
      const cssFiles = Object.keys(bundle).filter(i => i.endsWith('.css'));

      for (const htmlFile of htmlFiles) {
        const htmlChunk = bundle[htmlFile];
        if (htmlChunk.type === 'asset' && typeof htmlChunk.source === 'string') {
          let html = htmlChunk.source;

          // Inline each CSS file
          for (const cssFile of cssFiles) {
            const cssChunk = bundle[cssFile];
            if (cssChunk.type === 'asset' && typeof cssChunk.source === 'string') {
              const cssContent = cssChunk.source;

              // Check if CSS contains </style> which would break inlining
              if (cssContent.includes('</style>')) {
                console.error(`CSS contains </style> tag - this will break inlining!`);
              }

              // Replace the <link> tag with inline <style>
              const linkRegex = new RegExp(`<link[^>]*href="[./]*${cssFile}"[^>]*>`, 'g');
              html = html.replace(linkRegex, `<style>${cssContent}</style>`);

              // Delete the CSS file from bundle
              delete bundle[cssFile];
            }
          }

          htmlChunk.source = html;
        }
      }
    }
  };
}

export default defineConfig({
  plugins: [
    vue(),
    tailwindcss(),
    inlineCss(),
    sri(),
    visualizer({
      filename: 'stats.html',      // Default tree map
      gzipSize: true,
      brotliSize: true,
    }),
    // Add text-based output
    visualizer({
      filename: 'stats.txt',       // Text tree output
      template: 'list',                  // or 'raw-data' for JSON
      gzipSize: true,
      brotliSize: true,
    })
  ],
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
    assetsDir: '',
    cssCodeSplit: false,
    modulePreload: true,
    
    rollupOptions: {
      output: {
        // Inline tiny chunks like the Vue export helper
        experimentalMinChunkSize: 1024*6
      }
    }    
  },
  test: {
    environment: 'happy-dom',
    globals: true
  }
})
