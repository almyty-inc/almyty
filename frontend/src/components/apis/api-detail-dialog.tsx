import React from 'react'
import { UseMutationResult } from '@tanstack/react-query'
import {
  Upload, TestTube, ExternalLink, Download, FileCode,
  Globe, Database, Cloud, Server, Code, Copy,
  CheckCircle, AlertCircle, XCircle,
  Lock, Unlock, Shield, Key, ChevronRight
} from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'

import { formatDateTime, cn } from '@/lib/utils'
import { Api, ApiType, ApiHealthStatus, ApiAuthType, ApiOperation } from '@/types'

function getApiTypeIcon(type: ApiType) {
  switch (type) {
    case ApiType.OPENAPI: return Globe
    case ApiType.GRAPHQL: return Database
    case ApiType.SOAP: return Cloud
    case ApiType.GRPC: return Server
    case ApiType.OTHER: return Code
    default: return Code
  }
}

function getHealthStatusIcon(status: ApiHealthStatus) {
  switch (status) {
    case ApiHealthStatus.HEALTHY: return CheckCircle
    case ApiHealthStatus.DEGRADED: return AlertCircle
    case ApiHealthStatus.UNHEALTHY: return XCircle
    default: return AlertCircle
  }
}

function getHealthStatusColor(status: ApiHealthStatus) {
  switch (status) {
    case ApiHealthStatus.HEALTHY: return 'text-green-500'
    case ApiHealthStatus.DEGRADED: return 'text-yellow-500'
    case ApiHealthStatus.UNHEALTHY: return 'text-red-500'
    default: return 'text-gray-500'
  }
}

function getAuthTypeIcon(type?: ApiAuthType) {
  switch (type) {
    case ApiAuthType.API_KEY: return Key
    case ApiAuthType.BEARER_TOKEN: return Shield
    case ApiAuthType.BASIC_AUTH: return Lock
    case ApiAuthType.OAUTH2: return Unlock
    default: return Unlock
  }
}

interface ApiDetailDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  selectedApi: Api | null
  operations: ApiOperation[]
  allTools: any[]
  testResults: any | null
  onOpenUploadDialog: () => void
  generateToolsMutation: UseMutationResult<any, any, any, any>
  testApiMutation: UseMutationResult<any, any, any, any>
  onCopySuccess: (title: string, message: string) => void
}

export function ApiDetailDialog({
  open,
  onOpenChange,
  selectedApi,
  operations,
  allTools,
  testResults,
  onOpenUploadDialog,
  generateToolsMutation,
  testApiMutation,
  onCopySuccess,
}: ApiDetailDialogProps) {
  if (!selectedApi) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center space-x-2">
            <div className="w-8 h-8 bg-primary/10 rounded-lg flex items-center justify-center">
              {React.createElement(getApiTypeIcon(selectedApi.type), { className: "h-4 w-4" })}
            </div>
            <span>{selectedApi.name}</span>
            <Badge variant={selectedApi.healthStatus === ApiHealthStatus.HEALTHY ? 'success' : 'destructive'}>
              {selectedApi.healthStatus}
            </Badge>
          </DialogTitle>
          <DialogDescription>
            Manage API configuration, operations, and generated tools
          </DialogDescription>
        </DialogHeader>

        <Tabs defaultValue="overview" className="w-full mt-6">
          <TabsList className="grid w-full grid-cols-5">
            <TabsTrigger value="overview">Overview</TabsTrigger>
            <TabsTrigger value="operations">Operations</TabsTrigger>
            <TabsTrigger value="auth">Authentication</TabsTrigger>
            <TabsTrigger value="schema">Schema</TabsTrigger>
            <TabsTrigger value="test">Test</TabsTrigger>
          </TabsList>

          <TabsContent value="overview" className="space-y-4">
            <div className="grid gap-4 md:grid-cols-3">
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Health Status</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center space-x-2">
                    {React.createElement(getHealthStatusIcon(selectedApi.healthStatus), {
                      className: cn('h-6 w-6', getHealthStatusColor(selectedApi.healthStatus))
                    })}
                    <span className="font-medium capitalize">{selectedApi.healthStatus}</span>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">API Type</CardTitle>
                </CardHeader>
                <CardContent>
                  <Badge variant="outline" className="text-base">
                    {selectedApi.type.toUpperCase()}
                  </Badge>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm font-medium">Base URL</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center space-x-2">
                    <code className="bg-muted px-2 py-1 rounded text-sm truncate">
                      {selectedApi.baseUrl}
                    </code>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        navigator.clipboard.writeText(selectedApi.baseUrl)
                        onCopySuccess('Copied', 'Base URL copied to clipboard')
                      }}
                    >
                      <Copy className="h-3 w-3" />
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </div>

            <div className="grid gap-4 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <CardTitle className="text-base">API Information</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between">
                    <span>Version</span>
                    <span className="font-medium">{selectedApi.version || 'Not specified'}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Authentication</span>
                    <div className="flex items-center space-x-1">
                      {React.createElement(getAuthTypeIcon(selectedApi.authentication?.type), {
                        className: 'h-4 w-4'
                      })}
                      <span className="text-sm">
                        {selectedApi.authentication?.type?.replace('_', ' ').toUpperCase() || 'None'}
                      </span>
                    </div>
                  </div>
                  <div className="flex justify-between">
                    <span>Last Tested</span>
                    <span className="text-sm">
                      {selectedApi.lastTestedAt ? formatDateTime(selectedApi.lastTestedAt) : 'Never'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Status</span>
                    <Badge variant={selectedApi.isActive ? 'success' : 'secondary'}>
                      {selectedApi.isActive ? 'Active' : 'Inactive'}
                    </Badge>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader>
                  <CardTitle className="text-base">Generated Assets</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="flex justify-between">
                    <span>Tools Generated</span>
                    <span className="font-medium">{allTools.filter((t: any) => t.metadata?.apiId === selectedApi.id || (t.operationId && selectedApi.operations?.some((op: any) => op.id === t.operationId))).length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Operations Parsed</span>
                    <span className="font-medium">{operations.length}</span>
                  </div>
                  <div className="flex justify-between">
                    <span>Schema Format</span>
                    <span className="text-sm">
                      {selectedApi.schema?.format?.toUpperCase() || 'Not uploaded'}
                    </span>
                  </div>
                  <div className="flex justify-between">
                    <span>Schema Version</span>
                    <span className="text-sm">
                      {selectedApi.schema?.version || 'Unknown'}
                    </span>
                  </div>
                </CardContent>
              </Card>
            </div>

            <Card>
              <CardHeader>
                <CardTitle className="text-base">Quick Actions</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-2 md:grid-cols-2 lg:grid-cols-4">
                  <Button variant="outline" onClick={onOpenUploadDialog}>
                    <Upload className="mr-2 h-4 w-4" />
                    Import Schema
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => generateToolsMutation.mutate({ id: selectedApi.id })}
                    disabled={generateToolsMutation.isPending}
                  >
                    {/* Zap icon inline */}
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mr-2 h-4 w-4"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>
                    Generate Tools
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => testApiMutation.mutate({ id: selectedApi.id })}
                    disabled={testApiMutation.isPending}
                  >
                    <TestTube className="mr-2 h-4 w-4" />
                    Test Connection
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => window.open(selectedApi.baseUrl, '_blank')}
                  >
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open API
                  </Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="operations" className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-medium">API Operations</h3>
              <Badge variant="outline">
                {operations.length} operations
              </Badge>
            </div>

            <div className="grid gap-4">
              {operations.map((operation: ApiOperation) => (
                <Card key={operation.id}>
                  <CardContent className="flex items-center justify-between p-4">
                    <div className="flex items-center space-x-3">
                      <div className="w-8 h-8 bg-secondary rounded-lg flex items-center justify-center">
                        <Code className="h-4 w-4" />
                      </div>
                      <div>
                        <div className="font-medium">{operation.name}</div>
                        <div className="text-sm text-muted-foreground">
                          {operation.description || 'No description'}
                        </div>
                        <div className="flex items-center space-x-2 mt-1">
                          {operation.method && (
                            <Badge variant="outline" className="text-xs">
                              {operation.method}
                            </Badge>
                          )}
                          {operation.path && (
                            <code className="text-xs bg-muted px-1 rounded">
                              {operation.path}
                            </code>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="flex items-center space-x-2">
                      <Badge variant="secondary">
                        {operation.parameters?.length || 0} params
                      </Badge>
                      <Button size="sm" variant="ghost">
                        <ChevronRight className="h-4 w-4" />
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              ))}

              {operations.length === 0 && (
                <div className="text-center py-8 text-muted-foreground">
                  No operations found. Upload a schema to parse API operations.
                </div>
              )}
            </div>
          </TabsContent>

          <TabsContent value="auth" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>Authentication Configuration</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <Label>Authentication Type</Label>
                  <Select defaultValue={selectedApi.authentication?.type || ApiAuthType.NONE}>
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={ApiAuthType.NONE}>No Authentication</SelectItem>
                      <SelectItem value={ApiAuthType.API_KEY}>API Key</SelectItem>
                      <SelectItem value={ApiAuthType.BEARER_TOKEN}>Bearer Token</SelectItem>
                      <SelectItem value={ApiAuthType.BASIC_AUTH}>Basic Auth</SelectItem>
                      <SelectItem value={ApiAuthType.OAUTH2}>OAuth 2.0</SelectItem>
                      <SelectItem value={ApiAuthType.CUSTOM}>Custom</SelectItem>
                    </SelectContent>
                  </Select>
                </div>

                {selectedApi.authentication?.type === ApiAuthType.API_KEY && (
                  <>
                    <div>
                      <Label>API Key</Label>
                      <Input
                        type="password"
                        placeholder="Enter API key"
                        defaultValue={selectedApi.authentication.config.apiKey}
                      />
                    </div>
                    <div>
                      <Label>Header Name</Label>
                      <Input
                        placeholder="X-API-Key"
                        defaultValue={selectedApi.authentication.config.headerName || 'X-API-Key'}
                      />
                    </div>
                  </>
                )}

                {selectedApi.authentication?.type === ApiAuthType.BEARER_TOKEN && (
                  <div>
                    <Label>Bearer Token</Label>
                    <Input
                      type="password"
                      placeholder="Enter bearer token"
                      defaultValue={selectedApi.authentication.config.token}
                    />
                  </div>
                )}

                {selectedApi.authentication?.type === ApiAuthType.BASIC_AUTH && (
                  <>
                    <div>
                      <Label>Username</Label>
                      <Input
                        placeholder="Enter username"
                        defaultValue={selectedApi.authentication.config.username}
                      />
                    </div>
                    <div>
                      <Label>Password</Label>
                      <Input
                        type="password"
                        placeholder="Enter password"
                        defaultValue={selectedApi.authentication.config.password}
                      />
                    </div>
                  </>
                )}

                <div className="pt-4">
                  <Button>Save Authentication</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="schema" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>API Schema</CardTitle>
                <CardDescription>
                  View and manage the API schema definition
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {selectedApi.schema ? (
                  <>
                    <div className="grid gap-4 md:grid-cols-2">
                      <div>
                        <Label>Schema Format</Label>
                        <p className="text-sm">{selectedApi.schema.format.toUpperCase()}</p>
                      </div>
                      <div>
                        <Label>Schema Version</Label>
                        <p className="text-sm">{selectedApi.schema.version || 'Unknown'}</p>
                      </div>
                    </div>

                    <div>
                      <Label>Schema Content</Label>
                      <div className="bg-muted p-4 rounded-md mt-2 max-h-96 overflow-y-auto">
                        <pre className="text-sm">
                          {JSON.stringify(selectedApi.schema.content, null, 2)}
                        </pre>
                      </div>
                    </div>

                    <div className="flex space-x-2">
                      <Button variant="outline">
                        <Download className="mr-2 h-4 w-4" />
                        Download Schema
                      </Button>
                      <Button variant="outline" onClick={onOpenUploadDialog}>
                        <Upload className="mr-2 h-4 w-4" />
                        Update Schema
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="text-center py-8">
                    <FileCode className="mx-auto h-12 w-12 text-muted-foreground mb-4" />
                    <h3 className="text-lg font-medium mb-2">No Schema Uploaded</h3>
                    <p className="text-muted-foreground mb-4">
                      Upload an API schema to automatically generate tools and operations.
                    </p>
                    <Button onClick={onOpenUploadDialog}>
                      <Upload className="mr-2 h-4 w-4" />
                      Import Schema
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="test" className="space-y-4">
            <Card>
              <CardHeader>
                <CardTitle>API Connection Test</CardTitle>
                <CardDescription>
                  Test the API connection and verify authentication
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex space-x-2">
                  <Button
                    onClick={() => testApiMutation.mutate({ id: selectedApi.id })}
                    disabled={testApiMutation.isPending}
                  >
                    {testApiMutation.isPending ? (
                      <LoadingSpinner className="mr-2" />
                    ) : (
                      <TestTube className="mr-2 h-4 w-4" />
                    )}
                    {testApiMutation.isPending ? 'Testing...' : 'Test Connection'}
                  </Button>
                  <Button variant="outline" onClick={() => window.open(selectedApi.baseUrl, '_blank')}>
                    <ExternalLink className="mr-2 h-4 w-4" />
                    Open in Browser
                  </Button>
                </div>

                {testResults && (
                  <div className="mt-4">
                    <Label>Test Results</Label>
                    <div className="bg-muted p-4 rounded-md mt-2">
                      <pre className="text-sm overflow-x-auto">
                        {JSON.stringify(testResults, null, 2)}
                      </pre>
                    </div>
                  </div>
                )}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}
