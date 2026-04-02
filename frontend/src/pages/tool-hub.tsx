import React, { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Search, Download, Package, ChevronDown, ChevronRight, Plus, Tag } from 'lucide-react'

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { LoadingSpinner } from '@/components/ui/loading-spinner'
import { toolHubApi } from '@/lib/api'
import { useOrganizationStore } from '@/store/organization'
import { useNotifications } from '@/store/app'
import { ToolTemplate } from '@/types'

interface Provider {
  name: string
  icon?: string
  description?: string
  templateCount: number
  categories: string[]
}

export function ToolHubPage() {
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

  const { data: providersData, isLoading: providersLoading } = useQuery({
    queryKey: ['tool-hub-providers'],
    queryFn: () => toolHubApi.getProviders(),
    enabled: !!currentOrganization,
  })

  const { data: templatesData, isLoading: templatesLoading } = useQuery({
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

  const installTemplateMutation = useMutation({
    mutationFn: (templateId: string) => toolHubApi.installTemplate(templateId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['tools'] })
      queryClient.invalidateQueries({ queryKey: ['tool-hub-templates'] })
      success('Installed', 'Tool template installed successfully.')
    },
    onError: (err: any) => {
      error('Install failed', err.response?.data?.message || err.message || 'Failed to install template.')
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
      error('Install failed', err.response?.data?.message || err.message || 'Failed to install provider tools.')
    },
  })

  const providers: Provider[] = Array.isArray(providersData) ? providersData : []
  const templates: ToolTemplate[] = Array.isArray(templatesData?.templates || templatesData) ? (templatesData?.templates || templatesData) : []
  const categories: string[] = Array.isArray(categoriesData) ? categoriesData : []

  const isLoading = providersLoading || templatesLoading

  // Group templates by provider
  const templatesByProvider: Record<string, ToolTemplate[]> = {}
  templates.forEach((t) => {
    if (!templatesByProvider[t.provider]) templatesByProvider[t.provider] = []
    templatesByProvider[t.provider].push(t)
  })

  const filteredProviders = providers.filter((p) => {
    if (!searchQuery) return true
    return p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
      (p.description || '').toLowerCase().includes(searchQuery.toLowerCase())
  })

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-4xl font-heading font-extrabold tracking-tight bg-gradient-to-r from-foreground to-foreground/70 bg-clip-text text-transparent">Tool Hub</h1>
          <p className="text-muted-foreground">
            Browse and install pre-built tool templates from popular providers.
          </p>
        </div>
      </div>

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
                key={cat}
                variant={categoryFilter === cat ? 'default' : 'outline'}
                size="sm"
                onClick={() => setCategoryFilter(cat)}
              >
                {cat}
              </Button>
            ))}
          </div>
        )}
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center h-64">
          <LoadingSpinner size="lg" />
        </div>
      ) : providers.length === 0 && templates.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-16">
            <div className="w-16 h-16 bg-primary/10 rounded-full flex items-center justify-center mb-4">
              <Package className="h-8 w-8 text-primary" />
            </div>
            <h3 className="text-xl font-semibold mb-2">No templates available</h3>
            <p className="text-muted-foreground mb-4 text-center max-w-md">
              Tool Hub templates will appear here once they are configured on the backend.
              You can still create custom tools from the Tools page.
            </p>
            <Button variant="outline" onClick={() => window.location.href = '/tools'}>
              Go to Tools
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-4">
          {/* Provider Cards Grid */}
          {filteredProviders.length > 0 && (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {filteredProviders.map((provider) => (
                <Card
                  key={provider.name}
                  className="cursor-pointer hover:border-primary/50 transition-colors"
                  onClick={() => setExpandedProvider(expandedProvider === provider.name ? null : provider.name)}
                >
                  <CardHeader className="pb-3">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className="w-10 h-10 bg-primary/10 rounded-lg flex items-center justify-center">
                          {provider.icon ? (
                            <img src={provider.icon} alt={provider.name} className="w-6 h-6" />
                          ) : (
                            <Package className="h-5 w-5 text-primary" />
                          )}
                        </div>
                        <div>
                          <CardTitle className="text-base">{provider.name}</CardTitle>
                          <p className="text-xs text-muted-foreground">
                            {provider.templateCount} tool{provider.templateCount !== 1 ? 's' : ''}
                          </p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={(e) => {
                            e.stopPropagation()
                            installProviderMutation.mutate(provider.name)
                          }}
                          disabled={installProviderMutation.isPending}
                        >
                          <Download className="h-3 w-3 mr-1" />
                          Install All
                        </Button>
                        {expandedProvider === provider.name
                          ? <ChevronDown className="h-4 w-4 text-muted-foreground" />
                          : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                      </div>
                    </div>
                  </CardHeader>
                  {provider.description && (
                    <CardContent className="pt-0">
                      <p className="text-sm text-muted-foreground">{provider.description}</p>
                      {provider.categories.length > 0 && (
                        <div className="flex gap-1 mt-2 flex-wrap">
                          {provider.categories.map((cat) => (
                            <Badge key={cat} variant="secondary" className="text-xs">{cat}</Badge>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  )}
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
                  {searchQuery ? 'Search Results' : 'All Templates'}
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
    </div>
  )
}
