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
/**
 * Where the dev proxy sends API traffic.
 *
 * One constant rather than a port repeated per rule, so a developer
 * whose 4000 is already taken sets VITE_API_TARGET once and every path
 * follows. Previously only /api honoured it and the rest were pinned,
 * which sent auth to whatever else was listening on 4000.
 */
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:4000'

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
      // Same-origin API for the hosted chat app, mirroring the ingress
      // rule that routes /api on a tenant host to the API service. The
      // hosted chat client must be same-origin or the anonymous session
      // cookie lands on the wrong host and every visitor looks new on
      // every request. VITE_API_TARGET overrides the port for anyone
      // whose 3000 is already taken.
      '/api': {
        target: apiTarget,
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/api/, ''),
      },
      // PostHog reverse proxy for local dev — mirrors the nginx /ingest
      // proxy that runs in production (frontend/nginx.conf). Events go to
      // the same-origin /ingest path so ad blockers can't drop them, and
      // dev forwards them on to PostHog Cloud EU. /ingest/static/* serves
      // the SDK asset bundle; /ingest/array/* is SDK remote config;
      // everything else is ingestion. Keep more-specific paths first.
      '/ingest/static': {
        target: 'https://eu-assets.i.posthog.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/ingest\/static/, '/static'),
      },
      '/ingest/array': {
        target: 'https://eu-assets.i.posthog.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/ingest\/array/, '/array'),
      },
      '/ingest': {
        target: 'https://eu.i.posthog.com',
        changeOrigin: true,
        secure: true,
        rewrite: (p) => p.replace(/^\/ingest/, ''),
      },
      '/auth': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/users': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/organizations': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      // NOTE: no bypassHtmlGetRequests here — the referral attribution
      // flow navigates the BROWSER to /referrals/attribute/:code (an HTML
      // GET) and that must reach the backend so it can set the cookie.
      '/referrals': {
        target: apiTarget,
        changeOrigin: true,
      },
      // The agent factory. /apps is both an API prefix and a router
      // path, so HTML GETs stay with the SPA and everything else
      // (including /apps/:slug/builds) reaches the backend.
      '/apps': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/gateways': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/tools': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/apis': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/llm-providers': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/memory': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/monitoring': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/analytics': {
        target: apiTarget,
        changeOrigin: true,
        bypass: bypassHtmlGetRequests,
      },
      '/mcp': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/utcp': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/a2a': {
        target: apiTarget,
        changeOrigin: true,
      },
      '/docs': {
        target: apiTarget,
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
