import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Download, Package, ChevronDown, ChevronRight, Plus, Store, Trash2 } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { QueryError } from '@/components/ui/query-error'
import { EmptyState } from '@/components/ui/empty-state'
import { useNavigate } from 'react-router-dom'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { toolHubApi } from '@/lib/api'
import { formatDate } from '@/lib/utils'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { ToolTemplate } from '@/types'
import { getApiErrorMessage } from '@/lib/api-error'

/**
 * A provider rollup as the backend sends it: `GET /tool-hub/providers`
 * groups templates by provider and answers `{ provider, providerIcon,
 * count }`. The page previously read `name` / `icon` / `templateCount`,
 * which no response ever carried.
 */
interface ProviderRollup {
  provider: string
  providerIcon: string | null
  count: number
}

/** `GET /tool-hub/categories` answers rollups too, not bare strings. */
interface CategoryRollup {
  category: string
  count: number
}

export function ToolHubPage() {
  const navigate = useNavigate()
  useEffect(() => {
    document.title = 'Tool Hub | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { currentOrganization } = useOrganizationStore()
  const { success, error } = useNotifications()
  const queryClient = useQueryClient()

  const [searchQuery, setSearchQuery] = useState('')
  const [expandedProvider, setExpandedProvider] = useState<string | null>(null)
  const [categoryFilter, setCategoryFilter] = useState<string>('all')
  const [retractingTemplate, setRetractingTemplate] = useState<ToolTemplate | null>(null)

  const {
    data: providersData,
    isLoading: providersLoading,
    isError: providersError,
    error: providersErrorValue,
    refetch: refetchProviders,
  } = useQuery({
    queryKey: ['tool-hub-providers'],
    queryFn: () => toolHubApi.getProviders(),
    enabled: !!currentOrganization,
  })

  const {
    data: templatesData,
    isLoading: templatesLoading,
    isError: templatesError,
  } = useQuery({
    queryKey: ['tool-hub-templates', searchQuery, categoryFilter],
    queryFn: () => {
      const params: Record<string, string> = {}
      if (searchQuery) params.search = searchQuery
      if (categoryFilter !== 'all') params.category = categoryFilter
      return toolHubApi.getTemplates(params)
    },
    enabled: !!currentOrganization,
  })

  const { data: categoriesData } = useQuery({
    queryKey: ['tool-hub-categories'],
    queryFn: () => toolHubApi.getCategories(),
    enabled: !!currentOrganization,
  })

  const invalidateHub = () => {
    queryClient.invalidateQueries({ queryKey: ['tool-hub-templates'] })
    queryClient.invalidateQueries({ queryKey: ['tool-hub-providers'] })
    queryClient.invalidateQueries({ queryKey: ['tool-hub-categories'] })
  }

  const installTemplateMutation = useMutation({
    mutationFn: (templateId: string) => toolHubApi.installTemplate(templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tool-hub-templates'] })
      success('Installed', 'Tool template installed successfully.')
    },
    onError: (err: any) => {
      error('Install failed', getApiErrorMessage(err, 'Failed to install template.'))
    },
  })

  const installProviderMutation = useMutation({
    mutationFn: (provider: string) => toolHubApi.installProvider(provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tool-hub-providers'] })
      success('Installed', 'All tools from this provider installed successfully.')
    },
    onError: (err: any) => {
      error('Install failed', getApiErrorMessage(err, 'Failed to install provider tools.'))
    },
  })

  const retractMutation = useMutation({
    mutationFn: (templateId: string) => toolHubApi.deleteTemplate(templateId),
    onSuccess: () => {
      invalidateHub()
      setRetractingTemplate(null)
      success('Retracted', 'The template is no longer in your hub.')
    },
    onError: (err: any) => {
      error('Retract failed', getApiErrorMessage(err, 'Failed to retract template.'))
    },
  })

  const providers: ProviderRollup[] = Array.isArray(providersData) ? providersData : []
  const templates: ToolTemplate[] = Array.isArray(templatesData?.templates || templatesData)
    ? (templatesData?.templates || templatesData)
    : []
  const categories: CategoryRollup[] = Array.isArray(categoriesData) ? categoriesData : []

  const isLoading = providersLoading || templatesLoading

  // A template with an organizationId belongs to this organization -- the
  // backend only ever returns public templates and your own. Those are the
  // ones this org published, and the only ones it can retract.
  const publishedHere = templates.filter((t) => !!t.organizationId)

  // Group templates by provider
  const templatesByProvider: Record<string, ToolTemplate[]> = {}
  templates.forEach((t) => {
    if (!templatesByProvider[t.provider]) templatesByProvider[t.provider] = []
    templatesByProvider[t.provider].push(t)
  })

  const filteredProviders = providers.filter((p) => {
    if (!searchQuery) return true
    return p.provider.toLowerCase().includes(searchQuery.toLowerCase())
  })

  return (
    <div className="space-y-6">
      {/* Rendered as the Tools page's "Tool Hub" tab, under that page's
          header: a second gradient page title here read as a new page. */}
      <p className="text-sm text-muted-foreground">
        Install tool templates, and publish your own for the rest of your organization.
      </p>

      {/* Search and Filters */}
      <div className="flex items-center gap-4">
        <div className="flex-1 relative">
          <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search providers and templates..."
            className="pl-10"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>
        {categories.length > 0 && (
          <div className="flex gap-2 flex-wrap">
            <Button
              variant={categoryFilter === 'all' ? 'default' : 'outline'}
              size="sm"
              onClick={() => setCategoryFilter('all')}
            >
              All
            </Button>
            {categories.map((cat) => (
              <Button
                key={cat.category}
                variant={categoryFilter === cat.category ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCategoryFilter(cat.category)}
              >
                {cat.category}
                <span className="ml-1.5 text-xs text-muted-foreground">{cat.count}</span>
              </Button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <LoadingSpinner size="lg" />
        </div>
      ) : providersError || templatesError ? (
        // Both lists default to [], so a 500 or a dropped connection
        // landed in the empty state below and told the user the Tool Hub
        // is not configured -- when it is broken -- with no retry.
        <QueryError
          error={providersErrorValue}
          onRetry={() => refetchProviders()}
          title="Couldn't load the Tool Hub"
        />
      ) : providers.length === 0 && templates.length === 0 ? (
        <EmptyState
          variant="panel"
          icon={Store}
          title="Nothing published yet"
          description="Your hub fills up when someone publishes a tool into it. Open My tools, pick a working HTTP tool, and choose Publish to hub — credentials are stripped on the way."
          action={
            <Button variant="outline" onClick={() => navigate('/tools')}>
              Go to my tools
            </Button>
          }
        />
      ) : (
        <div className="space-y-4">
          {/* Templates this organization published */}
          {publishedHere.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">Published by your organization</CardTitle>
                <CardDescription>
                  {publishedHere.length} template{publishedHere.length !== 1 ? 's' : ''} only your organization can see
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {publishedHere.map((template) => (
                    <div
                      key={template.id}
                      className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/30"
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{template.name}</span>
                          <Badge variant="secondary" className="text-xs">{template.provider}</Badge>
                          <Badge variant="outline" className="text-xs border-cyan-600/40 text-cyan-700 dark:border-cyan-400/40 dark:text-cyan-400">
                            {template.category}
                          </Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {template.description}
                        </p>
                        {template.createdAt && (
                          <p className="text-xs text-muted-foreground mt-1">
                            Published {formatDate(template.createdAt)}
                            {template.installCount > 0 ? ` · ${template.installCount} installs` : ''}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => installTemplateMutation.mutate(template.id)}
                          disabled={installTemplateMutation.isPending}
                        >
                          <Plus className="h-3 w-3 mr-1" />
                          Add
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Retract ${template.name}`}
                          onClick={() => setRetractingTemplate(template)}
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* Provider Cards Grid */}
          {filteredProviders.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredProviders.map((provider) => (
                <Card
                  key={provider.provider}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setExpandedProvider(expandedProvider === provider.provider ? null : provider.provider)}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                          {provider.providerIcon ? (
                            <img src={provider.providerIcon} alt={provider.provider} className="w-6 h-6" />
                          ) : (
                            <Package className="h-5 w-5 text-primary" />
                          )}
                        </div>
                        <div>
                          <CardTitle className="text-base">{provider.provider}</CardTitle>
                          <p className="text-xs text-muted-foreground">
                            {provider.count} tool{provider.count !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation()
                            installProviderMutation.mutate(provider.provider)
                          }}
                          disabled={installProviderMutation.isPending}
                        >
                          <Download className="h-3 w-3 mr-1" />
                          Install all
                        </Button>
                        {expandedProvider === provider.provider
                          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </div>
                  </CardHeader>
                </Card>
              ))}
            </div>
          )}

          {/* Expanded Provider Templates */}
          {expandedProvider && templatesByProvider[expandedProvider] && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {expandedProvider} Templates
                </CardTitle>
                <CardDescription>
                  {templatesByProvider[expandedProvider].length} template{templatesByProvider[expandedProvider].length !== 1 ? 's' : ''} available
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {templatesByProvider[expandedProvider].map((template) => (
                    <div
                      key={template.id}
                      className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/30"
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{template.name}</span>
                          {template.tags?.length > 0 && (
                            <div className="flex gap-1">
                              {template.tags.slice(0, 3).map((tag) => (
                                <Badge key={tag} variant="outline" className="text-xs">{tag}</Badge>
                              ))}
                            </div>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {template.description}
                        </p>
                        <div className="flex items-center gap-3 mt-1">
                          <span className="text-xs text-muted-foreground">
                            {template.executionMethod}
                          </span>
                          {template.installCount > 0 && (
                            <span className="text-xs text-muted-foreground">
                              {template.installCount} installs
                            </span>
                          )}
                        </div>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => installTemplateMutation.mutate(template.id)}
                        disabled={installTemplateMutation.isPending}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}

          {/* All Templates (when searching or no providers) */}
          {(searchQuery || filteredProviders.length === 0) && templates.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle className="text-lg">
                  {searchQuery ? 'Search results' : 'All templates'}
                </CardTitle>
                <CardDescription>
                  {templates.length} template{templates.length !== 1 ? 's' : ''} found
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="space-y-3">
                  {templates.map((template) => (
                    <div
                      key={template.id}
                      className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/30"
                    >
                      <div className="flex-1 min-w-0 mr-4">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-sm">{template.name}</span>
                          <Badge variant="secondary" className="text-xs">{template.provider}</Badge>
                        </div>
                        <p className="text-xs text-muted-foreground mt-1 truncate">
                          {template.description}
                        </p>
                      </div>
                      <Button
                        size="sm"
                        onClick={() => installTemplateMutation.mutate(template.id)}
                        disabled={installTemplateMutation.isPending}
                      >
                        <Plus className="h-3 w-3 mr-1" />
                        Add
                      </Button>
                    </div>
                  ))}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      )}

      <AlertDialog
        open={!!retractingTemplate}
        onOpenChange={(open) => !open && setRetractingTemplate(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Retract this template?</AlertDialogTitle>
            <AlertDialogDescription>
              {retractingTemplate?.name} leaves your hub. Tools already installed from
              it keep working — they are ordinary tools now.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => retractingTemplate && retractMutation.mutate(retractingTemplate.id)}
              disabled={retractMutation.isPending}
            >
              {retractMutation.isPending ? 'Retracting…' : 'Retract template'}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
