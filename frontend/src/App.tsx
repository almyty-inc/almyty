import React, { useEffect, useMemo } from 'react'
import { Routes, Route, Navigate, Outlet, useLocation } from 'react-router-dom'

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
import { ForgotPasswordPage } from '@/pages/auth/forgot-password'
import { LoginPage } from '@/pages/auth/login'
import { OAuthConsentPage } from '@/pages/oauth/consent'
import { RegisterPage } from '@/pages/auth/register'
import { ResetPasswordPage } from '@/pages/auth/reset-password'
import { VerifyEmailPage } from '@/pages/auth/verify-email'

// Store
import { useAuthStore } from '@/store/auth'

// Analytics — fire a PostHog $pageview on every client-side route change.
import { usePageviews } from '@/hooks/use-pageviews'

// Lazy-loaded pages — code-split into separate chunks
const DashboardPage = lazy(() => import('@/pages/dashboard').then(m => ({ default: m.DashboardPage })))
const GatewaysPage = lazy(() => import('@/pages/gateways').then(m => ({ default: m.GatewaysPage })))
const GatewayDetailPage = lazy(() => import('@/pages/gateway-detail').then(m => ({ default: m.GatewayDetailPage })))
const GatewayNewPage = lazy(() => import('@/pages/gateway-new').then(m => ({ default: m.GatewayNewPage })))
const AppNewPage = lazy(() => import('@/pages/app-new').then(m => ({ default: m.AppNewPage })))
const AppDistributionNewPage = lazy(() => import('@/pages/app-distribution-new').then(m => ({ default: m.AppDistributionNewPage })))
const AppDistributionPage = lazy(() => import('@/pages/app-distribution').then(m => ({ default: m.AppDistributionPage })))
const AppSigningNewPage = lazy(() => import('@/pages/app-signing-new').then(m => ({ default: m.AppSigningNewPage })))
const ApisPage = lazy(() => import('@/pages/apis').then(m => ({ default: m.ApisPage })))
const ApiDetailPage = lazy(() => import('@/pages/api-detail').then(m => ({ default: m.ApiDetailPage })))
const ApiNewPage = lazy(() => import('@/pages/api-new').then(m => ({ default: m.ApiNewPage })))
const ApiEditPage = lazy(() => import('@/pages/api-edit').then(m => ({ default: m.ApiEditPage })))
const ApiImportPage = lazy(() => import('@/pages/api-import').then(m => ({ default: m.ApiImportPage })))
const ToolsPage = lazy(() => import('@/pages/tools').then(m => ({ default: m.ToolsPage })))
const ToolDetailPage = lazy(() => import('@/pages/tool-detail').then(m => ({ default: m.ToolDetailPage })))
const ToolNewPage = lazy(() => import('@/pages/tool-new').then(m => ({ default: m.ToolNewPage })))
const ToolPublishPage = lazy(() => import('@/pages/tool-publish').then(m => ({ default: m.ToolPublishPage })))
const McpServerNewPage = lazy(() => import('@/pages/mcp-server-new').then(m => ({ default: m.McpServerNewPage })))
const LlmProvidersPage = lazy(() => import('@/pages/llm-providers').then(m => ({ default: m.LlmProvidersPage })))
const LlmProviderDetailPage = lazy(() => import('@/pages/llm-provider-detail').then(m => ({ default: m.LlmProviderDetailPage })))
const ModelsPage = lazy(() => import('@/pages/models').then(m => ({ default: m.ModelsPage })))
const ModelNewPage = lazy(() => import('@/pages/model-new').then(m => ({ default: m.ModelNewPage })))
const ModelDetailPage = lazy(() => import('@/pages/model-detail').then(m => ({ default: m.ModelDetailPage })))
const HostedModelPage = lazy(() => import('@/pages/hosted-model').then(m => ({ default: m.HostedModelPage })))
const LlmProviderNewPage = lazy(() => import('@/pages/llm-provider-new').then(m => ({ default: m.LlmProviderNewPage })))
const AnalyticsPage = lazy(() => import('@/pages/analytics').then(m => ({ default: m.AnalyticsPage })))
const CredentialsPage = lazy(() => import('@/pages/credentials').then(m => ({ default: m.CredentialsPage })))
const SettingsPage = lazy(() => import('@/pages/settings').then(m => ({ default: m.SettingsPage })))
const OrganizationsPage = lazy(() => import('@/pages/organizations').then(m => ({ default: m.OrganizationsPage })))
const ChatPage = lazy(() => import('@/pages/chat').then(m => ({ default: m.ChatPage })))
const AgentsPage = lazy(() => import('@/pages/agents').then(m => ({ default: m.AgentsPage })))
const AgentBuilderPage = lazy(() => import('@/pages/agent-builder').then(m => ({ default: m.AgentBuilderPage })))
const AgentImportPage = lazy(() => import('@/pages/agent-import').then(m => ({ default: m.AgentImportPage })))
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
const ReferralRedirectPage = lazy(() => import('@/pages/referral-redirect').then(m => ({ default: m.ReferralRedirectPage })))
const NotificationsPage = lazy(() => import('@/pages/notifications').then(m => ({ default: m.NotificationsPage })))
const ShortcutsPage = lazy(() => import('@/pages/shortcuts').then(m => ({ default: m.ShortcutsPage })))
const NotFoundPage = lazy(() => import('@/pages/not-found').then(m => ({ default: m.NotFoundPage })))

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

// The OAuth callback for the Connections layer lands the browser on
// /connections?connection=<id>&status=...; the gallery lives under Settings.
function ConnectionsRedirect() {
  const location = useLocation()
  return <Navigate to={`/settings/connections${location.search}`} replace />
}

import { HostedChatPage } from '@/pages/hosted-chat'
import { AppsPage } from '@/pages/apps'
import { AppDetailPage } from '@/pages/app-detail'
import { currentTenantSlug } from '@/lib/tenant-host'

function App() {
  const { checkAuth } = useAuthStore()

  // Resolved once: the host cannot change without a page load.
  const tenantSlug = useMemo(() => currentTenantSlug(), [])

  // Emit a PostHog $pageview on each SPA navigation (capture_pageview is
  // disabled at init, so this is what records client-side route changes).
  // Mounted here because App renders under <BrowserRouter> (main.tsx).
  usePageviews()

  // Tenant hosts are public chat, not the dashboard. checkAuth hits
  // /auth/profile; a 401 there redirects to /auth/login and is exactly
  // the dashboard sign-in the hosted URL must never show.
  useEffect(() => {
    if (tenantSlug) return
    checkAuth()
  }, [checkAuth, tenantSlug])

  // A tenant subdomain serves the hosted chat app and nothing else: no
  // dashboard routes, no auth bootstrap, no chance of a stray link
  // landing a member of the public on someone's settings page.
  if (tenantSlug) {
    return <HostedChatPage slug={tenantSlug} />
  }

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
          <Route path="/gateways/new" element={<GatewayNewPage />} />
          <Route path="/gateways/:id" element={<GatewayDetailPage />} />
          <Route path="/apis" element={<ApisPage />} />
          <Route path="/apis/new" element={<ApiNewPage />} />
          <Route path="/apis/:id" element={<ApiDetailPage />} />
          <Route path="/apis/:id/edit" element={<ApiEditPage />} />
          <Route path="/apis/:id/import" element={<ApiImportPage />} />
          <Route path="/tools" element={<ToolsPage />} />
          <Route path="/tools/new" element={<ToolNewPage />} />
          <Route path="/tools/mcp-servers/new" element={<McpServerNewPage />} />
          <Route path="/tools/:id" element={<ToolDetailPage />} />
          <Route path="/tools/:id/publish" element={<ToolPublishPage />} />
          <Route path="/tool-hub" element={<Navigate to="/tools?tab=hub" replace />} />
          <Route path="/agents" element={<AgentsPage />} />
          <Route path="/apps" element={<AppsPage />} />
          <Route path="/apps/new" element={<AppNewPage />} />
          <Route path="/apps/:slug" element={<AppDetailPage />} />
          <Route path="/apps/:slug/distributions/new" element={<AppDistributionNewPage />} />
          <Route path="/apps/:slug/distributions/:target" element={<AppDistributionPage />} />
          <Route path="/apps/:slug/distributions/:target/signing/new" element={<AppSigningNewPage />} />
          <Route path="/agents/new" element={<AgentBuilderPage />} />
          <Route path="/agents/import" element={<AgentImportPage />} />
          <Route path="/agents/:id" element={<AgentDetailPage />} />
          <Route path="/agents/:id/edit" element={<AgentBuilderPage />} />
          <Route path="/runners" element={<RunnersPage />} />
          <Route path="/runners/new" element={<RunnerNewPage />} />
          <Route path="/runners/:id" element={<RunnerDetailPage />} />
          <Route path="/approvals" element={<ApprovalsPage />} />
          <Route path="/workspaces" element={<WorkspacesPage />} />
          <Route path="/workspaces/:id" element={<WorkspaceDetailPage />} />
          <Route path="/chat" element={<ChatPage />} />
          <Route path="/models" element={<ModelsPage />} />
          <Route path="/models/new" element={<ModelNewPage />} />
          <Route path="/models/hosting/:deploymentId" element={<HostedModelPage />} />
          <Route path="/models/:id" element={<ModelDetailPage />} />
          <Route path="/llm-providers" element={<LlmProvidersPage />} />
          <Route path="/llm-providers/new" element={<LlmProviderNewPage />} />
          <Route path="/llm-providers/:id" element={<LlmProviderDetailPage />} />
          <Route path="/analytics/*" element={<AnalyticsPage />} />
          <Route path="/memories" element={<MemoriesPage />} />
          <Route path="/credentials/*" element={<CredentialsPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/connections" element={<ConnectionsRedirect />} />
          <Route path="/organizations" element={<OrganizationsPage />} />
          <Route path="/docs" element={<DocsPage />} />
          <Route path="/notifications" element={<NotificationsPage />} />
          <Route path="/shortcuts" element={<ShortcutsPage />} />
          {/* Unknown authed path → a real 404 inside the shell, NOT a
              silent redirect to the dashboard (which read as "my page
              vanished"). Sits inside the DashboardLayout parent route
              so it stays auth-protected: an unauthenticated visitor is
              still bounced to /auth/login by the layout. */}
          <Route path="*" element={<NotFoundPage />} />
        </Route>

        {/* Invite accept */}
        <Route path="/invite/accept" element={<AcceptInvitePage />} />

        {/* CLI login (browser-based auth flow for @almyty/auth) */}
        <Route path="/cli-login" element={<CliLoginPage />} />

        {/* Referral share links — public, sets the attribution cookie then lands on register */}
        <Route path="/r/:code" element={<ReferralRedirectPage />} />

        {/* Auth routes */}
        <Route path="/auth/*" element={
          <AuthLayout>
            <Routes>
              <Route path="login" element={<LoginPage />} />
              <Route path="register" element={<RegisterPage />} />
              <Route path="verify-email" element={<VerifyEmailPage />} />
              <Route path="forgot-password" element={<ForgotPasswordPage />} />
              <Route path="reset-password" element={<ResetPasswordPage />} />
              <Route path="*" element={<Navigate to="/auth/login" replace />} />
            </Routes>
          </AuthLayout>
        } />

        {/* OAuth consent screen — standalone, self-contained auth handling */}
        <Route path="/oauth/consent" element={<OAuthConsentPage />} />
        
        {/* Default redirect */}
        <Route path="/" element={<Navigate to="/dashboard" replace />} />
      </Routes>
      <Toaster />
    </>
  )
}

export default App