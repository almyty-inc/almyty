import React, { useEffect, lazy } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

// Layout components (kept eager — needed for every route).
// Each layout owns its own <Suspense> boundary so the shell
// (sidebar, header, main landmark) stays mounted while the
// lazy page chunk is fetching. A top-level Suspense would
// unmount the entire layout every navigation — on fresh-signup
// users hitting a fat chunk like /tools that looked like a
// 5–10s blank-screen regression in the Playwright smoke suite.
import { AuthLayout } from '@/components/layout/auth-layout'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { Toaster } from '@/components/ui/toaster'

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
const LlmProviderDetailPage = lazy(() => import('@/pages/llm-provider-detail').then(m => ({ default: m.LlmProviderDetailPage })))
const AnalyticsPage = lazy(() => import('@/pages/analytics').then(m => ({ default: m.AnalyticsPage })))
const CredentialsPage = lazy(() => import('@/pages/credentials').then(m => ({ default: m.CredentialsPage })))
const SettingsPage = lazy(() => import('@/pages/settings').then(m => ({ default: m.SettingsPage })))
const OrganizationsPage = lazy(() => import('@/pages/organizations').then(m => ({ default: m.OrganizationsPage })))
const ChatPage = lazy(() => import('@/pages/chat').then(m => ({ default: m.ChatPage })))
const AgentsPage = lazy(() => import('@/pages/agents').then(m => ({ default: m.AgentsPage })))
const AgentBuilderPage = lazy(() => import('@/pages/agent-builder').then(m => ({ default: m.AgentBuilderPage })))
const AgentDetailPage = lazy(() => import('@/pages/agent-detail').then(m => ({ default: m.AgentDetailPage })))
const MemoriesPage = lazy(() => import('@/pages/memories').then(m => ({ default: m.MemoriesPage })))
const DocsPage = lazy(() => import('@/pages/docs').then(m => ({ default: m.DocsPage })))
const ToolHubPage = lazy(() => import('@/pages/tool-hub').then(m => ({ default: m.ToolHubPage })))
const AcceptInvitePage = lazy(() => import('@/pages/accept-invite').then(m => ({ default: m.AcceptInvitePage })))
const CliLoginPage = lazy(() => import('@/pages/cli-login').then(m => ({ default: m.CliLoginPage })))

function App() {
  const { checkAuth } = useAuthStore()

  // Initialize auth state on app start
  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  return (
    <>
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
        <Route path="/tool-hub" element={<Navigate to="/tools?tab=hub" replace />} />
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
        <Route path="/llm-providers/:id" element={
          <DashboardLayout>
            <LlmProviderDetailPage />
          </DashboardLayout>
        } />
        <Route path="/analytics/*" element={
          <DashboardLayout>
            <AnalyticsPage />
          </DashboardLayout>
        } />
        <Route path="/memories" element={
          <DashboardLayout>
            <MemoriesPage />
          </DashboardLayout>
        } />
        <Route path="/credentials/*" element={
          <DashboardLayout>
            <CredentialsPage />
          </DashboardLayout>
        } />
        <Route path="/settings/*" element={
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

        {/* CLI login (browser-based auth flow for @almyty/auth) */}
        <Route path="/cli-login" element={<CliLoginPage />} />

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
      <Toaster />
    </>
  )
}

export default App