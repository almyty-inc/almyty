import React, { useEffect, Suspense, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

// Layout components (kept eager — needed for every route)
import { AuthLayout } from '@/components/layout/auth-layout'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { Toaster } from '@/components/ui/toaster'
import { LoadingSpinner } from '@/components/ui/loading-spinner'

// Auth pages (kept eager — first thing users see)
import { LoginPage } from '@/pages/auth/login'
import { RegisterPage } from '@/pages/auth/register'

// Store
import { useAuthStore } from '@/store/auth'

// Lazy-loaded pages — code-split into separate chunks
const DashboardPage = lazy(() => import('@/pages/dashboard').then(m => ({ default: m.DashboardPage })))
const GatewaysPage = lazy(() => import('@/pages/gateways').then(m => ({ default: m.GatewaysPage })))
const GatewayDetailPage = lazy(() => import('@/pages/gateway-detail').then(m => ({ default: m.GatewayDetailPage })))
const ApisPage = lazy(() => import('@/pages/apis').then(m => ({ default: m.ApisPage })))
const ApiDetailPage = lazy(() => import('@/pages/api-detail').then(m => ({ default: m.ApiDetailPage })))
const ToolsPage = lazy(() => import('@/pages/tools').then(m => ({ default: m.ToolsPage })))
const ToolDetailPage = lazy(() => import('@/pages/tool-detail').then(m => ({ default: m.ToolDetailPage })))
const LlmProvidersPage = lazy(() => import('@/pages/llm-providers').then(m => ({ default: m.LlmProvidersPage })))
const AnalyticsPage = lazy(() => import('@/pages/analytics').then(m => ({ default: m.AnalyticsPage })))
const SettingsPage = lazy(() => import('@/pages/settings').then(m => ({ default: m.SettingsPage })))
const OrganizationsPage = lazy(() => import('@/pages/organizations').then(m => ({ default: m.OrganizationsPage })))
const ChatPage = lazy(() => import('@/pages/chat').then(m => ({ default: m.ChatPage })))
const AgentsPage = lazy(() => import('@/pages/agents').then(m => ({ default: m.AgentsPage })))
const AgentBuilderPage = lazy(() => import('@/pages/agent-builder').then(m => ({ default: m.AgentBuilderPage })))
const AgentDetailPage = lazy(() => import('@/pages/agent-detail').then(m => ({ default: m.AgentDetailPage })))
const DocsPage = lazy(() => import('@/pages/docs').then(m => ({ default: m.DocsPage })))
const AcceptInvitePage = lazy(() => import('@/pages/accept-invite').then(m => ({ default: m.AcceptInvitePage })))

const PageLoader = () => (
  <div className="flex items-center justify-center h-96">
    <LoadingSpinner size="lg" />
  </div>
)

function App() {
  const { checkAuth } = useAuthStore()

  // Initialize auth state on app start
  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  return (
    <>
      <Suspense fallback={<PageLoader />}>
      <Routes>
        {/* Dashboard routes - protected */}
        <Route path="/dashboard" element={
          <DashboardLayout>
            <DashboardPage />
          </DashboardLayout>
        } />
        <Route path="/gateways" element={
          <DashboardLayout>
            <GatewaysPage />
          </DashboardLayout>
        } />
        <Route path="/gateways/:id" element={
          <DashboardLayout>
            <GatewayDetailPage />
          </DashboardLayout>
        } />
        <Route path="/apis" element={
          <DashboardLayout>
            <ApisPage />
          </DashboardLayout>
        } />
        <Route path="/apis/:id" element={
          <DashboardLayout>
            <ApiDetailPage />
          </DashboardLayout>
        } />
        <Route path="/tools" element={
          <DashboardLayout>
            <ToolsPage />
          </DashboardLayout>
        } />
        <Route path="/tools/:id" element={
          <DashboardLayout>
            <ToolDetailPage />
          </DashboardLayout>
        } />
        <Route path="/agents" element={
          <DashboardLayout>
            <AgentsPage />
          </DashboardLayout>
        } />
        <Route path="/agents/new" element={
          <DashboardLayout>
            <AgentBuilderPage />
          </DashboardLayout>
        } />
        <Route path="/agents/:id" element={
          <DashboardLayout>
            <AgentDetailPage />
          </DashboardLayout>
        } />
        <Route path="/agents/:id/edit" element={
          <DashboardLayout>
            <AgentBuilderPage />
          </DashboardLayout>
        } />
        <Route path="/chat" element={
          <DashboardLayout>
            <ChatPage />
          </DashboardLayout>
        } />
        <Route path="/llm-providers" element={
          <DashboardLayout>
            <LlmProvidersPage />
          </DashboardLayout>
        } />
        <Route path="/analytics" element={
          <DashboardLayout>
            <AnalyticsPage />
          </DashboardLayout>
        } />
        <Route path="/settings" element={
          <DashboardLayout>
            <SettingsPage />
          </DashboardLayout>
        } />
        <Route path="/organizations" element={
          <DashboardLayout>
            <OrganizationsPage />
          </DashboardLayout>
        } />
        <Route path="/docs" element={
          <DashboardLayout>
            <DocsPage />
          </DashboardLayout>
        } />

        {/* Invite accept */}
        <Route path="/invite/accept" element={<AcceptInvitePage />} />

        {/* Auth routes */}
        <Route path="/auth/*" element={
          <AuthLayout>
            <Routes>
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="*" element={<Navigate to="/auth/login" replace />} />
            </Routes>
          </AuthLayout>
        } />
        
        {/* Default redirect */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        <Route path="*" element={<Navigate to="/auth/login" replace />} />
      </Routes>
      </Suspense>
      <Toaster />
    </>
  )
}

export default App