import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'

const bypassHtmlGetRequests = (req) => {
  // Serve SPA for HTML GET requests, proxy API calls
  const acceptsHtml = req.headers.accept?.includes('text/html')
  if (req.method === 'GET' && acceptsHtml) {
    return '/index.html'
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  server: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '3000'),
    proxy: {
      '/auth': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/users': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/organizations': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      // NOTE: no bypassHtmlGetRequests here — the referral attribution
      // flow navigates the BROWSER to /referrals/attribute/:code (an HTML
      // GET) and that must reach the backend so it can set the cookie.
      '/referrals': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/gateways': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/tools': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/apis': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/llm-providers': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/memory': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/monitoring': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/analytics': {
        target: 'http://localhost:4000',
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/mcp': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/utcp': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/a2a': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
      '/docs': {
        target: 'http://localhost:4000',
        changeOrigin: true,
      },
    },
  },
  preview: {
    host: '0.0.0.0',
    port: parseInt(process.env.PORT || '3000'),
  },
  esbuild: {
    // Tree-shake debug-level console calls out of production bundles.
    // Marking them "pure" tells esbuild their return values are
    // side-effect-free and can be dropped when unused (which they
    // always are — console.log/debug/info return void).
    //
    // We deliberately keep console.warn and console.error alive so
    // the browser dev tools still surface real problems in prod.
    pure: ['console.log', 'console.debug', 'console.info', 'console.trace'],
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        // Ensure content hashes in filenames for cache busting
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash].[ext]',
      },
    },
  },
})
