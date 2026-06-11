import React from 'react'
import ReactDOM from 'react-dom/client'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { ReactQueryDevtools } from '@tanstack/react-query-devtools'
import { BrowserRouter } from 'react-router-dom'

import App from './App.tsx'
import { ErrorBoundary } from '@/components/ui/error-boundary'
import './index.css'

// Sentry error tracking — install @sentry/react and set VITE_SENTRY_DSN to enable
// import('@sentry/react').then(Sentry => Sentry.init({ dsn: import.meta.env.VITE_SENTRY_DSN }))

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

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter>
      <QueryClientProvider client={queryClient}>
        <App />
        <ReactQueryDevtools initialIsOpen={false} />
      </QueryClientProvider>
    </BrowserRouter>
  </React.StrictMode>,
)