import React, { useEffect } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'

// Layout components
import { AuthLayout } from '@/components/layout/auth-layout'
import { DashboardLayout } from '@/components/layout/dashboard-layout'
import { Toaster } from '@/components/ui/toaster'

// Auth pages  
import { LoginPage } from '@/pages/auth/login'
import { RegisterPage } from '@/pages/auth/register'

// Store
import { useAuthStore } from '@/store/auth'

// Dashboard pages
import { DashboardPage } from '@/pages/dashboard'
import { GatewaysPage } from '@/pages/gateways'
import { GatewayDetailPage } from '@/pages/gateway-detail'
import { ApisPage } from '@/pages/apis'
import { ApiDetailPage } from '@/pages/api-detail'
import { ToolsPage } from '@/pages/tools'
import { ToolDetailPage } from '@/pages/tool-detail'
import { LlmProvidersPage } from '@/pages/llm-providers'
import { AnalyticsPage } from '@/pages/analytics'
import { SettingsPage } from '@/pages/settings'
import { OrganizationsPage } from '@/pages/organizations'
import { ChatPage } from '@/pages/chat'
import { AgentsPage } from '@/pages/agents'

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
        <Route path="/agents" element={
          <DashboardLayout>
            <AgentsPage />
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