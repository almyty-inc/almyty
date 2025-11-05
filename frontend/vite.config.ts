import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import fs from 'fs'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    {
      name: 'spa-fallback',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          const url = req.url || ''

          // Skip API calls and static assets
          if (url.startsWith('/api/') ||
              url.startsWith('/@') ||
              url.includes('.')) {
            next()
            return
          }

          // For SPA routes, serve index.html
          if (url.match(/^\/(apis|tools|gateways|dashboard|analytics|settings|llm-providers|auth)/)) {
            req.url = '/'
          }

          next()
        })
      }
    }
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '3000'),
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '3000'),
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
})