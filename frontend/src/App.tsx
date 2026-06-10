import React, { useEffect } from 'react'
import { Routes, Route, Navigate, Outlet } from 'react-router-dom'

import { lazyWithRetry as lazy } from '@/lib/lazy-with-retry'

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
import { OAuthConsentPage } from '@/pages/oauth/consent'
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
const RunnersPage = lazy(() => import('@/pages/runners').then(m => ({ default: m.RunnersPage })))
const ApprovalsPage = lazy(() => import('@/pages/approvals').then(m => ({ default: m.ApprovalsPage })))
const RunnerDetailPage = lazy(() => import('@/pages/runner-detail').then(m => ({ default: m.RunnerDetailPage })))
const RunnerNewPage = lazy(() => import('@/pages/runner-new').then(m => ({ default: m.RunnerNewPage })))
const WorkspacesPage = lazy(() => import('@/pages/workspaces').then(m => ({ default: m.WorkspacesPage })))
const WorkspaceDetailPage = lazy(() => import('@/pages/workspace-detail').then(m => ({ default: m.WorkspaceDetailPage })))
const MemoriesPage = lazy(() => import('@/pages/memories').then(m => ({ default: m.MemoriesPage })))
const DocsPage = lazy(() => import('@/pages/docs').then(m => ({ default: m.DocsPage })))
const ToolHubPage = lazy(() => import('@/pages/tool-hub').then(m => ({ default: m.ToolHubPage })))
const AcceptInvitePage = lazy(() => import('@/pages/accept-invite').then(m => ({ default: m.AcceptInvitePage })))
const CliLoginPage = lazy(() => import('@/pages/cli-login').then(m => ({ default: m.CliLoginPage })))

// Layout wrapper that mounts once via parent Route + Outlet, so
// useLocation() inside the layout always reflects the *current*
// child route. The previous pattern wrapped every Route's element
// in <DashboardLayout>{<Page/>}</DashboardLayout> and reused the
// same layout instance across pages — useLocation would freeze on
// whichever pathname rendered the layout first, leaving the
// sidebar's active-item highlight stuck on the previous page.
function DashboardLayoutOutlet() {
  return (
    <DashboardLayout>
      <Outlet />
    </DashboardLayout>
  )
}

function App() {
  const { checkAuth } = useAuthStore()

  // Initialize auth state on app start
  useEffect(() => {
    checkAuth()
  }, [checkAuth])

  return (
    <>
      <Routes>
        {/* Dashboard routes - protected. Single parent route with
            <DashboardLayoutOutlet /> means the layout mounts ONCE
            and the child route swaps via <Outlet />. useLocation()
            inside the layout reliably reflects the active child. */}
        <Route element={<DashboardLayoutOutlet />}>
          <Route path="/dashboard" element={<DashboardPage />} />
          <Route path="/gateways" element={<GatewaysPage />} />
          <Route path="/gateways/:id" element={<GatewayDetailPage />} />
          <Route path="/apis" element={<ApisPage />} />
          <Route path="/apis/:id" element={<ApiDetailPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tools/:id" element={<ToolDetailPage />} />
          <Route path="/tool-hub" element={<Navigate to="/tools?tab=hub" replace />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/agents/new" element={<AgentBuilderPage />} />
          <Route path="/agents/:id" element={<AgentDetailPage />} />
          <Route path="/agents/:id/edit" element={<AgentBuilderPage />} />
          <Route path="/runners" element={<RunnersPage />} />
          <Route path="/runners/new" element={<RunnerNewPage />} />
          <Route path="/runners/:id" element={<RunnerDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/workspaces/:id" element={<WorkspaceDetailPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/llm-providers" element={<LlmProvidersPage />} />
          <Route path="/llm-providers/:id" element={<LlmProviderDetailPage />} />
          <Route path="/analytics/*" element={<AnalyticsPage />} />
          <Route path="/memories" element={<MemoriesPage />} />
          <Route path="/credentials/*" element={<CredentialsPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/organizations" element={<OrganizationsPage />} />
          <Route path="/docs" element={<DocsPage />} />
        </Route>

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

        {/* OAuth consent screen — standalone, self-contained auth handling */}
        <Route path="/oauth/consent" element={<OAuthConsentPage />} />
        
        {/* Default redirect */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
        {/* Unknown path → kick users to the dashboard, NOT to the
            login page. The dashboard is auth-protected, so an
            unauthenticated visitor still ends up at /auth/login, but
            an authenticated user who typo'd a URL or hit a stale
            bookmark no longer sees an apparent logout screen. */}
        <Route path="*" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}

export default App