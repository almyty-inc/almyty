import React, { Suspense } from 'react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'

interface AuthLayoutProps {
  children: React.ReactNode
}

export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="min-h-screen bg-muted flex flex-col justify-center py-12 sm:px-6 lg:px-8">
      <div className="sm:mx-auto sm:w-full sm:max-w-md">
        <div className="flex justify-center">
          <div className="flex items-center gap-2">
            <img src="/almyty-icon-48.svg" alt="almyty" className="w-10 h-10" />
            <span className="text-2xl font-heading font-medium tracking-tight text-foreground">almyty</span>
          </div>
        </div>
      </div>

      <div className="mt-8 sm:mx-auto sm:w-full sm:max-w-md">
        <div className="bg-card py-8 px-4 shadow sm:rounded-lg sm:px-10 border-t-2 border-t-violet-500/30">
          <Suspense
            fallback={
              <div className="flex items-center justify-center py-12" role="status" aria-label="Loading page">
                <LoadingSpinner size="lg" />
                <span className="sr-only">Loading…</span>
              </div>
            }
          >
            {children}
          </Suspense>
        </div>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} Almyty Inc.
        </p>
      </div>

    </div>
  )
}