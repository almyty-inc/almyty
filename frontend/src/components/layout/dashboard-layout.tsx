import React, { useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
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
} from 'lucide-react'

import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
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
import { useAppStore } from '@/store/app'
import { getInitials } from '@/lib/utils'

interface DashboardLayoutProps {
  children: React.ReactNode
}

const navigation = [
  { name: 'Dashboard', href: '/dashboard', icon: LayoutDashboard },
  { name: 'APIs', href: '/apis', icon: Globe },
  { name: 'Tools', href: '/tools', icon: Wrench },
  { name: 'Gateways', href: '/gateways', icon: Zap },
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Models', href: '/llm-providers', icon: Brain },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, isAuthenticated, logout, hasHydrated } = useAuthStore()
  const { currentOrganization, organizations, setCurrentOrganization, fetchOrganizations } = useOrganizationStore()
  const { sidebarOpen, setSidebarOpen, toggleSidebar, sidebarCollapsed, toggleSidebarCollapse } = useAppStore()
  const [darkMode, setDarkMode] = useState(() => {
    // Dark is the default; only light if explicitly stored
    return localStorage.getItem('theme') !== 'light'
  })

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
  }

  return (
    <div className="h-screen flex overflow-hidden bg-muted">
      {/* Sidebar */}
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-50 bg-card border-r transform transition-all duration-200 ease-in-out lg:translate-x-0 lg:static lg:inset-0",
          sidebarCollapsed ? "w-16" : "w-64",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex flex-col h-screen min-h-0">
          {/* Logo */}
          <div className={cn("flex items-center h-12 border-b shrink-0", sidebarCollapsed ? "justify-center px-2" : "justify-between px-3")}>
            <div className="flex items-center gap-2">
              <img src="/almyty-icon-48.svg" alt="almyty" className="w-8 h-8 shrink-0" />
              {!sidebarCollapsed && <span className="text-xl font-heading font-medium tracking-tight text-foreground">almyty</span>}
            </div>
            {!sidebarCollapsed && (
              <Button variant="ghost" size="icon" className="lg:hidden" onClick={() => setSidebarOpen(false)}>
                <X className="h-6 w-6" />
              </Button>
            )}
          </div>

          {/* Organization Selector */}
          {currentOrganization && !sidebarCollapsed && (
            <div className="px-3 py-2 border-b">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" size="sm" className="w-full justify-between h-8 text-xs">
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
            </div>
          )}

          {/* Navigation */}
          <nav className={cn("flex-1 min-h-0 py-2 space-y-0.5 overflow-y-auto", sidebarCollapsed ? "px-1" : "px-2")} aria-label="Main navigation">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href || location.pathname.startsWith(item.href + '/')
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  title={sidebarCollapsed ? item.name : undefined}
                  className={cn(
                    "group flex items-center rounded-md transition-colors",
                    sidebarCollapsed ? "justify-center px-2 py-1.5" : "px-3 py-1 text-[13px]",
                    isActive
                      ? "bg-primary/10 text-primary font-medium"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground"
                  )}
                >
                  <item.icon
                    className={cn(
                      "flex-shrink-0 h-5 w-5",
                      !sidebarCollapsed && "mr-3",
                      isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                    )}
                  />
                  {!sidebarCollapsed && item.name}
                </Link>
              )
            })}
          </nav>

          {/* User Menu + Collapse toggle */}
          <div className={cn("flex-shrink-0 border-t", sidebarCollapsed ? "p-1.5" : "px-3 py-2")}>
            {sidebarCollapsed ? (
              <div className="flex flex-col items-center gap-2">
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebarCollapse}
                  className="hidden lg:flex h-8 w-8 text-muted-foreground hover:text-foreground"
                  title="Expand sidebar"
                >
                  <ChevronRight className="h-4 w-4" />
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="w-full p-2 justify-center" aria-label="User menu">
                      <Avatar className="h-8 w-8">
                        <AvatarImage src={user?.avatar} />
                        <AvatarFallback>
                          {user?.name ? getInitials(user.name) : 'U'}
                        </AvatarFallback>
                      </Avatar>
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
            ) : (
              <div className="flex items-center gap-2">
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" className="flex-1 min-w-0 p-2 justify-start" aria-label="User menu">
                      <Avatar className="h-8 w-8 mr-3 flex-shrink-0">
                        <AvatarImage src={user?.avatar} />
                        <AvatarFallback>
                          {user?.name ? getInitials(user.name) : 'U'}
                        </AvatarFallback>
                      </Avatar>
                      <div className="text-left truncate">
                        <p className="text-sm font-medium text-foreground truncate">{user?.name || user?.email}</p>
                        {user?.name && <p className="text-xs text-muted-foreground truncate">{user?.email}</p>}
                      </div>
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
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={toggleSidebarCollapse}
                  className="hidden lg:flex h-8 w-8 flex-shrink-0 text-muted-foreground hover:text-foreground"
                  title="Collapse sidebar"
                >
                  <ChevronLeft className="h-4 w-4" />
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex flex-col flex-1 overflow-hidden">
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
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 relative overflow-y-auto overflow-x-hidden focus:outline-none">
          <div className="py-6">
            <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 xl:px-8">
              {children}
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