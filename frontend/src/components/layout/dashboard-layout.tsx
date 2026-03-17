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
  { name: 'Agents', href: '/agents', icon: Bot },
  { name: 'Chat', href: '/chat', icon: MessageSquare },
  { name: 'Gateways', href: '/gateways', icon: Zap },
  { name: 'AI Models', href: '/llm-providers', icon: Brain },
  { name: 'Analytics', href: '/analytics', icon: BarChart3 },
  { name: 'Settings', href: '/settings', icon: Settings },
]

export function DashboardLayout({ children }: DashboardLayoutProps) {
  const location = useLocation()
  const navigate = useNavigate()
  const { user, isAuthenticated, logout, hasHydrated } = useAuthStore()
  const { currentOrganization, organizations, setCurrentOrganization, fetchOrganizations } = useOrganizationStore()
  const { sidebarOpen, setSidebarOpen, toggleSidebar } = useAppStore()
  const [darkMode, setDarkMode] = useState(() => {
    return localStorage.getItem('theme') === 'dark' ||
      (!localStorage.getItem('theme') && window.matchMedia('(prefers-color-scheme: dark)').matches)
  })

  useEffect(() => {
    if (darkMode) {
      document.documentElement.classList.add('dark')
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
          "fixed inset-y-0 left-0 z-50 w-64 bg-card border-r transform transition-transform duration-200 ease-in-out lg:translate-x-0 lg:static lg:inset-0",
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        <div className="flex flex-col h-full">
          {/* Logo */}
          <div className="flex items-center justify-between h-14 px-4 border-b">
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">ai</span>
              </div>
              <span className="text-xl font-bold text-foreground">apifai</span>
            </div>
            <Button
              variant="ghost"
              size="icon"
              className="lg:hidden"
              onClick={() => setSidebarOpen(false)}
            >
              <X className="h-6 w-6" />
            </Button>
          </div>

          {/* Organization Selector */}
          {currentOrganization && (
            <div className="p-4 border-b">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button variant="outline" className="w-full justify-between">
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
          <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
            {navigation.map((item) => {
              const isActive = location.pathname === item.href
              return (
                <Link
                  key={item.name}
                  to={item.href}
                  className={cn(
                    "group flex items-center px-3 py-1.5 text-[13px] rounded-md transition-colors",
                    isActive
                      ? "bg-primary/10 text-primary border-l-2 border-primary font-medium"
                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground border-l-2 border-transparent"
                  )}
                >
                  <item.icon
                    className={cn(
                      "mr-3 flex-shrink-0 h-5 w-5",
                      isActive ? "text-primary" : "text-muted-foreground group-hover:text-foreground"
                    )}
                  />
                  {item.name}
                </Link>
              )
            })}
          </nav>

          {/* User Menu */}
          <div className="flex-shrink-0 border-t p-4">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="ghost" className="w-full justify-start p-2" aria-label="User menu">
                  <Avatar className="h-8 w-8 mr-3">
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
            >
              <Menu className="h-6 w-6" />
            </Button>
            <div className="flex items-center space-x-2">
              <div className="w-8 h-8 bg-gradient-to-br from-blue-600 to-purple-600 rounded-lg flex items-center justify-center">
                <span className="text-white font-bold text-sm">ai</span>
              </div>
              <span className="text-xl font-bold text-foreground">apifai</span>
            </div>
          </div>
        </header>

        {/* Page Content */}
        <main className="flex-1 relative overflow-y-auto focus:outline-none">
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