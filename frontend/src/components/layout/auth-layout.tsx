import React, { Suspense } from 'react'

import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { AlmytyMark } from './almyty-logo'

interface AuthLayoutProps {
  children: React.ReactNode
}

/**
 * Sign-in, sign-up and the other account pages. A white column holds the
 * mark and the form; from lg up the product-field colour fills the other
 * half with one plain sentence about what almyty is for. Nothing in it
 * claims anything the form does not do. On a phone it is just the white
 * column, no card around the form.
 */
export function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="min-h-screen bg-background lg:grid lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="flex min-h-screen flex-col px-4 py-6 sm:px-8 lg:px-12">
        <header>
          <a href="/" className="inline-flex items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2">
            <AlmytyMark />
            <span className="font-heading text-xl font-bold tracking-tight text-foreground">almyty</span>
          </a>
        </header>

        <main className="flex flex-1 items-center justify-center py-10">
          <div className="w-full max-w-[400px]">
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
        </main>

        <footer className="text-xs text-muted-foreground">
          &copy; {new Date().getFullYear()} Almyty Inc.
        </footer>
      </div>

      <aside
        aria-hidden
        data-testid="auth-product-field"
        className="relative hidden overflow-hidden bg-product-field lg:m-3 lg:flex lg:flex-col lg:justify-end lg:rounded-[24px] lg:p-12"
      >
        <AlmytyMark className="absolute right-12 top-12 h-16" />
        <p className="max-w-[28ch] font-heading text-[40px] font-extrabold leading-[1.08] tracking-[-0.04em] text-foreground">
          Your APIs, your models, agents that do the work.
        </p>
        <p className="mt-4 max-w-[46ch] text-base text-muted-foreground">
          Bring in the APIs you already use, pick the models you trust, and put agents where your team works.
        </p>
      </aside>
    </div>
  )
}