import { DETAIL_TITLE_CLASSES } from '@/components/layout/page-header'
import { useEffect, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, CheckCircle2, Copy, Key } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { accessKeysApi, agentsApi, gatewaysApi } from '@/lib/api'
import { getApiErrorMessage } from '@/lib/api-error'
import { useCopySensitive } from '@/lib/clipboard'
import { cn } from '@/lib/utils'
import { useNotifications } from '@/store/app'

const SCOPE_OPTIONS = ['read', 'write', 'execute', 'admin']

/**
 * Generate an access key for a gateway or an agent: a page of its own
 * (/credentials/access-keys/new), not a modal. The key is shown once, on
 * this page, after it is generated.
 */
export function AccessKeyNewPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const notify = useNotifications()
  const copySensitive = useCopySensitive()
  const [generatedKey, setGeneratedKey] = useState<string | null>(null)
  const [form, setForm] = useState({ name: '', resourceType: 'gateway' as 'gateway' | 'agent', resourceId: '', scopes: ['read'] as string[] })

  useEffect(() => {
    document.title = 'Generate access key | almyty'
    return () => { document.title = 'almyty' }
  }, [])

  const { data: gatewaysRaw } = useQuery({ queryKey: ['gateways'], queryFn: () => gatewaysApi.getAll() })
  const gateways: any[] = Array.isArray(gatewaysRaw) ? gatewaysRaw : (gatewaysRaw as any)?.gateways || []
  const { data: agentsRaw } = useQuery({ queryKey: ['agents'], queryFn: () => agentsApi.getAll() })
  const agents: any[] = Array.isArray(agentsRaw) ? agentsRaw : (agentsRaw as any)?.agents || []

  const createMut = useMutation({
    mutationFn: (data: any) => accessKeysApi.create(data),
    onSuccess: (data: any) => {
      qc.invalidateQueries({ queryKey: ['access-keys'] })
      setGeneratedKey(data?.key || data?.accessKey || 'Key generated')
      notify.success('Access key created', 'Copy it now -- it is not shown again.')
    },
    onError: (err) => notify.error('Could not generate the key', getApiErrorMessage(err, 'No key was created.')),
  })

  const toggleScope = (s: string) => setForm(f => ({ ...f, scopes: f.scopes.includes(s) ? f.scopes.filter(x => x !== s) : [...f.scopes, s] }))
  const handleGenerate = () => {
    const p: any = { name: form.name, scopes: form.scopes }
    if (form.resourceType === 'gateway') p.gatewayId = form.resourceId; else p.agentId = form.resourceId
    createMut.mutate(p)
  }
  const resources = form.resourceType === 'gateway' ? gateways : agents

  return (
    <div className="space-y-6">
      <div>
        <Link to="/credentials/access-keys" className="inline-flex items-center text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="mr-1 h-4 w-4" />
          Access keys
        </Link>
      </div>

      <div>
        <h1 className={DETAIL_TITLE_CLASSES}>{generatedKey ? 'Key generated' : 'Generate access key'}</h1>
        <p className="text-sm text-muted-foreground mt-1">
          {generatedKey ? 'Copy this key now. It will not be shown again.' : 'Create a new access key for a gateway or agent.'}
        </p>
      </div>

      <Card className="max-w-2xl">
        <CardContent className="pt-6">
          {generatedKey ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2 bg-muted p-3 rounded-lg">
                <code className="text-sm flex-1 break-all select-all" data-sensitive-text>{generatedKey}</code>
                <Button variant="ghost" size="sm" aria-label="Copy access key" onClick={() => copySensitive(generatedKey, 'Access key')}><Copy className="h-4 w-4" /></Button>
              </div>
              <div className="flex items-center gap-2 text-amber-600 text-sm"><Key className="h-4 w-4" /> Store this key securely. It cannot be retrieved later.</div>
              <div className="flex justify-end">
                <Button onClick={() => navigate('/credentials/access-keys')}>Done</Button>
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              <div><label className="text-sm font-medium" htmlFor="access-key-name">Name</label>
                <Input id="access-key-name" placeholder="e.g. Production Key" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
              <div><label className="text-sm font-medium">Resource Type</label>
                <Select value={form.resourceType} onValueChange={(v: 'gateway' | 'agent') => setForm(f => ({ ...f, resourceType: v, resourceId: '' }))}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent><SelectItem value="gateway">Gateway</SelectItem><SelectItem value="agent">Agent</SelectItem></SelectContent>
                </Select></div>
              <div><label className="text-sm font-medium">{form.resourceType === 'gateway' ? 'Gateway' : 'Agent'}</label>
                <Select value={form.resourceId} onValueChange={v => setForm(f => ({ ...f, resourceId: v }))}>
                  <SelectTrigger><SelectValue placeholder="Select..." /></SelectTrigger>
                  <SelectContent>
                    {resources.length === 0 && (
                      <div className="px-3 py-2 text-sm text-muted-foreground">
                        {form.resourceType === 'gateway' ? 'No gateways yet.' : 'No agents yet.'}
                      </div>
                    )}
                    {resources.map((r: any) => <SelectItem key={r.id} value={r.id}>{r.name}</SelectItem>)}
                  </SelectContent>
                </Select></div>
              <div><label className="text-sm font-medium">Scopes</label>
                <div className="flex gap-2 flex-wrap mt-1">
                  {SCOPE_OPTIONS.map(scope => (
                    <button key={scope} type="button" onClick={() => toggleScope(scope)} className={cn(
                      'px-3 py-1 rounded-full text-xs font-medium border transition-colors',
                      form.scopes.includes(scope) ? 'bg-primary text-primary-foreground border-primary' : 'bg-background text-muted-foreground border-border hover:border-primary/50'
                    )}>{form.scopes.includes(scope) && <CheckCircle2 className="h-3 w-3 inline mr-1" />}{scope}</button>
                  ))}
                </div></div>
              {/* A disabled button that does not say why is a dead end. */}
              {(!form.name || !form.resourceId) && (
                <p className="text-xs text-muted-foreground">
                  {!form.name ? 'Give the key a name' : `Choose the ${form.resourceType} this key is for`} to continue.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => navigate('/credentials/access-keys')}>Cancel</Button>
                <Button disabled={!form.name || !form.resourceId || createMut.isPending} onClick={handleGenerate}>
                  {createMut.isPending ? 'Generating...' : 'Generate key'}
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
