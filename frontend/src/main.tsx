import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { createBrowserRouter, RouterProvider } from 'react-router-dom'

import { createAppRoutes } from './App.tsx'
import { AppErrorFallback } from '@/components/layout/route-error'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import { initAnalytics } from '@/lib/analytics'
import { initSentry } from '@/lib/sentry'
import { telemetryAllowedOn } from '@/lib/tenant-host'

import './index.css'

// Sentry error tracking — no-op unless ALMYTY_SENTRY_DSN is set. Same
// host-based environment gate as analytics (dev untracked). See
// src/lib/sentry.ts.
// Neither runs on a tenant's chat host: those visitors are the tenant's
// users, not ours. See telemetryAllowedOn in src/lib/tenant-host.ts.
if (telemetryAllowedOn()) {
  initSentry()

  // PostHog product analytics — no-op unless ALMYTY_POSTHOG_KEY is set.
  // Cookieless, EU host; see src/lib/analytics.ts.
  initAnalytics()
}


// Create a client
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30000, // 30 seconds before refetch
      gcTime: 5 * 60 * 1000, // keep unused data 5 minutes
      retry: 1,
      refetchOnWindowFocus: false,
    },
    mutations: {
      retry: 1,
    },
  },
})

// A data router, not <BrowserRouter>: create and configure flows are pages,
// and a page with unsaved changes asks before it is left (useLeaveGuard).
// react-router's useBlocker only works under a data router, and so does
// errorElement, which is how a page that throws shows an error instead of
// a white screen (see createAppRoutes in App.tsx).
const router = createBrowserRouter(createAppRoutes())

// The outer ErrorBoundary is for errors above or outside the router (a
// provider, the router itself). Route render errors never reach it: the
// route errorElements catch them first and keep the shell up.
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary fallbackRender={(error) => <AppErrorFallback error={error} />}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </ErrorBoundary>
  </React.StrictMode>,
)