import React, { Suspense, useEffect, useState } from 'react'
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import {
  LayoutDashboard,
  Building,
  Zap,
  Globe,
  Wrench,
  Brain,
  BarChart3,
  Settings,
  LogOut,
  Menu,
  X,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Router,
  Activity,
  Bot,
  MessageSquare,
  Sun,
  Moon,
  Key,
  Database,
  Store,
  Cpu,
  Shield,
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { SetupPill } from '@/components/onboarding/setup-pill'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useAuthStore } from '@/store/auth'
import { useOrganizationStore } from '@/store/organization'
import { useAppStore, useNotifications } from '@/store/app'
import { getInitials } from '@/lib/utils'
import { CommandPalette } from '@/components/command-palette'
import { KeyboardShortcutsDialog } from '@/components/keyboard-shortcuts'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { NotificationBell } from '@/components/notifications/notification-bell'
import { EmailVerificationBanner } from '@/components/layout/email-verification-banner'
import { PlanBadge } from '@/components/plan-indicator'

// Suspense fallback for lazy page chunks. Rendered INSIDE the main
// landmark so the sidebar + header + <main> stay mounted during
// route chunk loads — previously the Suspense boundary sat in
// App.tsx above the layout, which meant every lazy page navigation
// briefly tore the entire shell down to a centred spinner on a
// blank background. On fresh-signup users hitting the Tools page
// (one of the fattest chunks, with CodeMirror + multiple dialog
// subcomponents), that blank state could persist for 5–10s on a
// slow connection, which the Playwright smoke suite caught as a
// "missing main landmark" failure.
function PageContentFallback() {
  return (
    <div className="flex items-center justify-center h-[60vh]" role="status" aria-label="Loading page">
      <LoadingSpinner size="lg" />
      <span className="sr-only">Loading…</span>
    </div>
  )
}

interface DashboardLayoutProps {
  children: React.ReactNode
}

// Sidebar order follows the onboarding checklist on the
// Dashboard (Connect API → Generate Tools → Create Gateway →
// Build Agent) and the `docs/brand` IA rules — reading the
// sidebar top-down tells a new user the same story the
// onboarding flow tells them. Previously Agents was first,
// which rewarded existing users who already knew they wanted
// an agent but left newcomers wondering what to click first.
const navigation: { name: string; href: string; icon: any; dataTour?: string }[] = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  // Core workflow — follows the APIs → Tools → Gateways → Agents
  // pipeline narrative.
  { name: 'APIs', href: '/apis', icon: Globe, dataTour: 'nav-api' },
  { name: 'Tools', href: '/tools', icon: Wrench },
  { name: 'Gateways', href: '/gateways', icon: Zap, dataTour: 'nav-gateway' },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Runners', href: '/runners', icon: Cpu },
  { name: 'Credentials', href: '/credentials', icon: Key },
  { name: 'Approvals', href: '/approvals', icon: Shield },
  // Configuration
  { name: 'divider', href: '', icon: null as any },
  { name: 'Models', href: '/llm-providers', icon: Brain, dataTour: 'nav-provider' },
  { name: 'Memory', href: '/memories', icon: Database },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, isAuthenticated, logout, hasHydrated } = useAuthStore()
  const { currentOrganization, organizations, setCurrentOrganization, fetchOrganizations } = useOrganizationStore()
  const queryClient = useQueryClient()
  const { sidebarOpen, setSidebarOpen, toggleSidebar, sidebarCollapsed, toggleSidebarCollapse } = useAppStore()
  const [darkMode, setDarkMode] = useState(() => {
    // Dark is the default; only light if explicitly stored
    return localStorage.getItem('theme') !== 'light'
  })

  // Ensure sidebar starts closed on mobile (safety net for store default)
  useEffect(() => {
    if (window.innerWidth < 1024) {
      setSidebarOpen(false)
    }
  }, [])

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
      document.documentElement.classList.remove('light')
      localStorage.setItem('theme', 'dark')
    } else {
      document.documentElement.classList.remove('dark')
      localStorage.setItem('theme', 'light')
    }
  }, [darkMode])

  // Check authentication and redirect if not logged in (only after hydration)
  useEffect(() => {
    if (hasHydrated && !isAuthenticated) {
      navigate('/auth/login')
      return
    }
  }, [isAuthenticated, hasHydrated, navigate])

  // Initialize organizations from user data when available
  useEffect(() => {
    if (user && organizations.length === 0) {
      const { initializeFromUser } = useOrganizationStore.getState()
      initializeFromUser(user)
    }
  }, [user, organizations.length])

  // Listen for 403 responses from the axios interceptor and surface
  // them as a permission toast. Before this the 403s that came back
  // on GET queries (no per-mutation onError handler) would be
  // silently swallowed — the user just saw a blank screen with no
  // explanation of why the page didn't load.
  const notifications = useNotifications()
  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent).detail as
        | { url?: string; method?: string; message?: string }
        | undefined
      notifications.warning(
        'Permission denied',
        detail?.message || "You don't have permission to perform this action.",
      )
    }
    window.addEventListener('almyty:api-forbidden', handler)
    return () => window.removeEventListener('almyty:api-forbidden', handler)
  }, [notifications])

  // Show loading only while hydrating or not authenticated
  if (!hasHydrated || !isAuthenticated) {
    return (
      <div className="h-screen flex items-center justify-center bg-muted">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-foreground mx-auto mb-4"></div>
          <p className="text-muted-foreground">Loading...</p>
        </div>
      </div>
    )
  }

  const handleLogout = () => {
    logout()
    navigate('/auth/login')
  }

  const handleOrgChange = (org: any) => {
    setCurrentOrganization(org)
    // Every cached query belongs to the previous organization (the
    // X-Organization-Id header changes with the store). Without this,
    // pages keep showing the old org's data — e.g. the dashboard
    // onboarding checklist carried its progress over to a brand-new
    // empty org until a hard reload.
    queryClient.invalidateQueries()
  }

  return (
    <div className="h-screen flex overflow-hidden bg-muted">
      {/* Skip to main content — keyboard users should be able to
       * bypass the 14-item sidebar on every page. Hidden visually
       * until it receives focus, then pops in at the top-left as
       * a first-class link. */}
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:absolute focus:top-2 focus:left-2 focus:z-[9999] focus:rounded-md focus:border focus:border-primary focus:bg-background focus:px-3 focus:py-2 focus:text-sm focus:font-medium focus:text-foreground focus:shadow-lg"
      >
        Skip to main content
      </a>
      {/* Global command palette — ⌘K / Ctrl+K toggle registered
       * inside the component. Mounted once at the layout root so
       * it's reachable from every authenticated page. */}
      <CommandPalette />
      {/* Keyboard shortcuts help dialog — `?` key toggles it
       * from anywhere outside of an editable field. */}
      <KeyboardShortcutsDialog />
      {/* Sidebar */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 bg-card border-r transform transition-all duration-200 ease-in-out lg:translate-x-0 lg:static lg:inset-0",
          sidebarCollapsed ? "w-16" : "w-64",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className={cn("flex items-center h-14 border-b", sidebarCollapsed ? "justify-center px-2" : "justify-between px-4")}>
            <div className="flex items-center gap-2">
              <img src="/almyty-icon-48.svg" alt="almyty" className="w-8 h-8 shrink-0" />
              {!sidebarCollapsed && <span className="text-xl font-heading font-medium tracking-tight text-foreground">almyty</span>}
            </div>
            {!sidebarCollapsed && (
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="Close navigation" onClick={() => setSidebarOpen(false)}>
                <X className="h-6 w-6" />
              </Button>
            )}
          </div>

          {/* Organization Selector */}
          {currentOrganization && !sidebarCollapsed && (
            <div className="p-4 border-b">
              <DropdownMenu onOpenChange={(open) => { if (open) fetchOrganizations().catch(() => null) }}>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full justify-between" aria-label={`Switch organization, current: ${currentOrganization.name}`}>
                    <div className="flex items-center space-x-2">
                      <div className="w-6 h-6 bg-muted rounded flex items-center justify-center">
                        <span className="text-xs font-medium">
                          {getInitials(currentOrganization.name)}
                        </span>
                      </div>
                      <span className="truncate">{currentOrganization.name}</span>
                    </div>
                    <ChevronDown className="h-4 w-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent className="w-56">
                  <DropdownMenuLabel>Organizations</DropdownMenuLabel>
                  <DropdownMenuSeparator />
                  {organizations.map((org) => (
                    <DropdownMenuItem
                      key={org.id}
                      onClick={() => handleOrgChange(org)}
                      className="flex items-center justify-between"
                    >
                      <div className="flex items-center space-x-2">
                        <div className="w-4 h-4 bg-muted rounded flex items-center justify-center">
                          <span className="text-xs">{getInitials(org.name)}</span>
                        </div>
                        <span>{org.name}</span>
                      </div>
                      {org.id === currentOrganization.id && (
                        <Badge variant="secondary" className="text-xs">Current</Badge>
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
              <div className="mt-2 flex items-center justify-between">
                <span className="text-xs text-muted-foreground">Plan</span>
                <PlanBadge />
              </div>
            </div>
          )}

          {/* Command palette hint — a visible affordance for the
           * ⌘K / Ctrl+K shortcut registered in <CommandPalette/>.
           * Clicking dispatches a synthetic keydown so there's one
           * code path that opens the dialog. Hidden when the
           * sidebar is collapsed (no room for the key hint). */}
          {!sidebarCollapsed && (
            <div className="px-2 pt-3">
              <button
                type="button"
                onClick={() => {
                  document.dispatchEvent(
                    new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
                  )
                }}
                className="w-full flex items-center gap-2 rounded-md border border-border/60 bg-muted/40 px-3 py-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
                aria-label="Open command palette"
              >
                <span className="text-muted-foreground">Search or jump to…</span>
                <kbd className="ml-auto inline-flex items-center gap-1 rounded border border-border/80 bg-background px-1.5 py-0.5 text-[10px] font-mono text-muted-foreground">
                  ⌘K
                </kbd>
              </button>
            </div>
          )}

          {/* Navigation */}
          <nav key={location.pathname} className={cn("flex-1 py-4 space-y-1 overflow-y-auto", sidebarCollapsed ? "px-1" : "px-2")} aria-label="Main navigation">
            {navigation.map((item) => {
              if (item.name === 'divider') {
                return <div key="divider" className="my-2 mx-3 border-t border-border/40" />
              }
              // NavLink computes `isActive` per-render against the live
              // router location, sidestepping the React reconciliation
              // edge cases that left a manual useLocation()-based check
              // stuck on the previous page across SPA navigation.
              return (
                <NavLink
                  key={item.name}
                  data-tour={item.dataTour}
                  to={item.href}
                  end={item.href === '/dashboard'}
                  title={sidebarCollapsed ? item.name : undefined}
                  className={({ isActive }) => cn(
                    "group relative flex items-center rounded-md transition-colors",
                    sidebarCollapsed ? "justify-center px-2 py-2" : "px-3 py-1.5 text-[13px]",
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    // DS sidebar-active signature: violet->cyan gradient accent bar
                    isActive && !sidebarCollapsed &&
                      "before:absolute before:left-0 before:top-1/2 before:h-4 before:w-[3px] before:-translate-y-1/2 before:rounded-full before:bg-gradient-to-b before:from-violet-500 before:to-cyan-400"
                  )}
                >
                  {({ isActive }) => (
                    <>
                      <item.icon
                        className={cn(
                          "flex-shrink-0 h-5 w-5",
                          !sidebarCollapsed && "mr-3",
                          isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                        )}
                      />
                      {!sidebarCollapsed && item.name}
                    </>
                  )}
                </NavLink>
              )
            })}
          </nav>

          {/* Collapse toggle — desktop only */}
          <div className="hidden lg:flex justify-end px-2 py-2 border-t">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebarCollapse}
              className="h-8 w-8 text-muted-foreground hover:text-foreground"
              aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
              title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"}
            >
              {sidebarCollapsed ? <ChevronRight className="h-4 w-4" /> : <ChevronLeft className="h-4 w-4" />}
            </Button>
          </div>

          {/* Onboarding setup pill — lingers until real activation */}
          <div className={cn("flex-shrink-0", sidebarCollapsed ? "px-2 pt-2" : "px-4 pt-3")}>
            <SetupPill collapsed={sidebarCollapsed} />
          </div>

          {/* User Menu */}
          <div className={cn("flex-shrink-0 border-t", sidebarCollapsed ? "p-2" : "p-4")}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className={cn("w-full p-2", sidebarCollapsed ? "justify-center" : "justify-start")} aria-label="User menu">
                  <Avatar className={cn("h-8 w-8", !sidebarCollapsed && "mr-3")}>
                    <AvatarImage src={user?.avatar} />
                    <AvatarFallback>
                      {user?.name ? getInitials(user.name) : 'U'}
                    </AvatarFallback>
                  </Avatar>
                  {!sidebarCollapsed && (
                    <div className="text-left truncate">
                      <p className="text-sm font-medium text-foreground truncate">{user?.name || user?.email}</p>
                      {user?.name && <p className="text-xs text-muted-foreground truncate">{user?.email}</p>}
                    </div>
                  )}
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent className="w-56" align="end" forceMount>
                <DropdownMenuLabel className="font-normal">
                  <div className="flex flex-col space-y-1">
                    <p className="text-sm font-medium leading-none">{user?.name}</p>
                    <p className="text-xs leading-none text-muted-foreground">{user?.email}</p>
                  </div>
                </DropdownMenuLabel>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate('/settings')}>
                  <Settings className="mr-2 h-4 w-4" />
                  <span>Settings</span>
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => setDarkMode(!darkMode)}>
                  {darkMode ? <Sun className="mr-2 h-4 w-4" /> : <Moon className="mr-2 h-4 w-4" />}
                  <span>{darkMode ? 'Light mode' : 'Dark mode'}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={handleLogout}>
                  <LogOut className="mr-2 h-4 w-4" />
                  <span>Log out</span>
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-col flex-1 overflow-hidden">
        {/* Email verification nudge — renders only when the backend
         * explicitly reports emailVerified === false. */}
        <EmailVerificationBanner />
        {/* Top Bar */}
        <header className="bg-background shadow-sm border-b lg:hidden">
          <div className="flex items-center justify-between h-16 px-4">
            <Button
              variant="ghost"
              size="icon"
              onClick={toggleSidebar}
              aria-label="Toggle navigation menu"
            >
              <Menu className="h-6 w-6" />
            </Button>
            <div className="flex items-center gap-2">
              <img src="/almyty-icon-48.svg" alt="almyty" className="w-8 h-8" />
              <span className="text-xl font-heading font-medium tracking-tight text-foreground">almyty</span>
            </div>
            <NotificationBell />
          </div>
        </header>

        {/* Desktop utility bar — a thin strip that hosts the notification
         * bell (right). It shares the page background (no separate fill,
         * no border) so it reads as part of the content rather than a
         * heavy top band. There is no section title here: every page
         * renders its own heading, so a duplicate would be redundant. */}
        <div className="hidden lg:flex items-center justify-end h-10 px-4 sm:px-6 lg:px-8">
          <NotificationBell />
        </div>

        {/* Page Content */}
        <main
          id="main-content"
          tabIndex={-1}
          aria-label="Main content"
          className="flex-1 relative overflow-y-auto focus:outline-none"
        >
          <div className="py-6">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 xl:px-8">
              <Suspense fallback={<PageContentFallback />}>
                {children}
              </Suspense>
            </div>
          </div>
        </main>
      </div>

      {/* Overlay for mobile */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={() => setSidebarOpen(false)}
        />
      )}
    </div>
  )
}