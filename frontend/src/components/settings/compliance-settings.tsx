/* compliance-settings — EE (compliance_pack) admin surface.
 *
 * Two cards: a policy config form that turns the OSS pii-filter +
 * security-scanner plugins into an ENFORCED org-wide layer (PUT
 * /compliance/policy), and a compliance report view scored from audit
 * activity (GET /compliance/report).
 *
 * Gated behind the `compliance_pack` entitlement: without a license the
 * whole surface renders an UpgradePrompt (Business tier) instead of
 * letting the admin click through to a 402. The backend EntitlementGuard
 * is the real boundary; this is the UX affordance.
 *
 * NOTE: this is the GATED compliance-pack policy at /compliance/*. It is
 * distinct from the ungated community `DataRetentionCard`
 * (/organizations/:id/retention) shown on the Organization tab — that
 * governs data retention windows, this governs enforced PII/security
 * controls. They do not share state or endpoints.
 */
import { useEffect, useMemo, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ShieldCheck, FileBarChart, ScanLine, EyeOff } from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Checkbox } from '@/components/ui/checkbox'
import { Progress } from '@/components/ui/progress'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { EntitlementGate } from '@/components/entitlement-gate'
import { UpgradePrompt } from '@/components/plan-indicator'
import { useNotifications } from '@/store/app'
import {
  complianceApi,
  type ComplianceReport,
  type ComplianceSeverity,
  type EffectiveCompliancePolicy,
  type EnforceablePlugin,
} from '@/lib/api'

/** PII categories the built-in pii-filter can mask (from the OSS plugin). */
const PII_CATEGORIES: Array<{ value: string; label: string }> = [
  { value: 'email', label: 'Email addresses' },
  { value: 'phone', label: 'Phone numbers' },
  { value: 'ssn', label: 'Social security numbers' },
  { value: 'credit_card', label: 'Credit card numbers' },
]

const SEVERITIES: ComplianceSeverity[] = ['low', 'medium', 'high', 'critical']

const policySchema = z.object({
  piiFilter: z.boolean(),
  securityScanner: z.boolean(),
  securityThreshold: z.enum(['low', 'medium', 'high', 'critical']),
  blockOnViolation: z.boolean(),
  piiCategories: z.array(z.string()),
})

type PolicyForm = z.infer<typeof policySchema>

function toForm(p: EffectiveCompliancePolicy): PolicyForm {
  return {
    piiFilter: p.enforcedPlugins.includes('pii-filter'),
    securityScanner: p.enforcedPlugins.includes('security-scanner'),
    securityThreshold: p.securityThreshold,
    blockOnViolation: p.blockOnViolation,
    piiCategories: p.piiCategories ?? [],
  }
}

export function ComplianceSettings() {
  return (
    <EntitlementGate
      feature="compliance_pack"
      mode="lock"
      fallback={
        <UpgradePrompt
          feature="compliance_pack"
          title="Compliance Pack"
          description="Enforce PII filtering and security scanning org-wide, and pull a scored compliance report over your audit activity."
        />
      }
    >
      <ComplianceSurface />
    </EntitlementGate>
  )
}

function ComplianceSurface() {
  return (
    <div className="space-y-6">
      <CompliancePolicyForm />
      <ComplianceReportCard />
    </div>
  )
}

function CompliancePolicyForm() {
  const queryClient = useQueryClient()
  const { success, error } = useNotifications()

  const { data, isLoading } = useQuery<EffectiveCompliancePolicy>({
    queryKey: ['compliance-policy'],
    queryFn: () => complianceApi.getPolicy(),
  })

  const {
    register,
    handleSubmit,
    reset,
    watch,
    setValue,
    formState: { isSubmitting },
  } = useForm<PolicyForm>({
    resolver: zodResolver(policySchema),
    defaultValues: {
      piiFilter: true,
      securityScanner: true,
      securityThreshold: 'medium',
      blockOnViolation: true,
      piiCategories: [],
    },
  })

  useEffect(() => {
    if (data) reset(toForm(data))
  }, [data, reset])

  const saveMutation = useMutation({
    mutationFn: (values: PolicyForm) => {
      const enforcedPlugins: EnforceablePlugin[] = []
      if (values.piiFilter) enforcedPlugins.push('pii-filter')
      if (values.securityScanner) enforcedPlugins.push('security-scanner')
      return complianceApi.updatePolicy({
        enforcedPlugins,
        securityThreshold: values.securityThreshold,
        blockOnViolation: values.blockOnViolation,
        piiCategories: values.piiCategories,
      })
    },
    onSuccess: async () => {
      success('Compliance policy saved', 'Enforced controls updated for your organization.')
      await queryClient.invalidateQueries({ queryKey: ['compliance-policy'] })
      await queryClient.invalidateQueries({ queryKey: ['compliance-report'] })
    },
    onError: (err: any) =>
      error('Failed to save', err.response?.data?.message || 'Please try again.'),
  })

  const piiFilter = watch('piiFilter')
  const securityScanner = watch('securityScanner')
  const blockOnViolation = watch('blockOnViolation')
  const piiCategories = watch('piiCategories')
  const securityThreshold = watch('securityThreshold')

  const toggleCategory = (value: string, checked: boolean) => {
    const next = new Set(piiCategories)
    if (checked) next.add(value)
    else next.delete(value)
    setValue('piiCategories', Array.from(next), { shouldDirty: true })
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          Loading compliance policy...
        </CardContent>
      </Card>
    )
  }

  const configured = data?.configured

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ShieldCheck className="h-5 w-5 text-primary" /> Compliance Policy
          {configured === false && (
            <Badge variant="outline" className="ml-1 text-muted-foreground">
              Using secure defaults
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Enforce the built-in PII filter and security scanner across every
          gateway and agent in this organization. Saving makes these controls
          mandatory — members can no longer disable them per gateway.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit((v) => saveMutation.mutate(v))} className="space-y-6">
          <div className="flex items-center justify-between">
            <div>
              <Label className="flex items-center gap-2">
                <EyeOff className="h-4 w-4 text-muted-foreground" /> Enforce PII filter
              </Label>
              <p className="text-xs text-muted-foreground">
                Mask personally identifiable information in requests and
                responses org-wide.
              </p>
            </div>
            <Switch
              checked={piiFilter}
              onCheckedChange={(v) => setValue('piiFilter', v, { shouldDirty: true })}
              aria-label="Enforce PII filter"
            />
          </div>

          {piiFilter && (
            <div className="space-y-2 rounded-md border p-4">
              <Label>PII categories to mask</Label>
              <p className="text-xs text-muted-foreground">
                Leave all unchecked to mask every built-in category.
              </p>
              <div className="grid grid-cols-2 gap-3 pt-1">
                {PII_CATEGORIES.map((cat) => (
                  <label key={cat.value} className="flex items-center gap-2 text-sm">
                    <Checkbox
                      checked={piiCategories.includes(cat.value)}
                      onCheckedChange={(v) => toggleCategory(cat.value, v === true)}
                      aria-label={cat.label}
                    />
                    {cat.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <Label className="flex items-center gap-2">
                <ScanLine className="h-4 w-4 text-muted-foreground" /> Enforce security scanner
              </Label>
              <p className="text-xs text-muted-foreground">
                Scan traffic for prompt-injection and threat patterns org-wide.
              </p>
            </div>
            <Switch
              checked={securityScanner}
              onCheckedChange={(v) => setValue('securityScanner', v, { shouldDirty: true })}
              aria-label="Enforce security scanner"
            />
          </div>

          {securityScanner && (
            <div className="space-y-2">
              <Label htmlFor="security-threshold">Severity threshold</Label>
              <Select
                value={securityThreshold}
                onValueChange={(v) =>
                  setValue('securityThreshold', v as ComplianceSeverity, { shouldDirty: true })
                }
              >
                <SelectTrigger id="security-threshold" className="w-48">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SEVERITIES.map((s) => (
                    <SelectItem key={s} value={s} className="capitalize">
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">
                Findings at or above this severity are acted on.
              </p>
            </div>
          )}

          <div className="flex items-center justify-between">
            <div>
              <Label>Block on violation</Label>
              <p className="text-xs text-muted-foreground">
                When on, a violation aborts the request. When off, it is only
                recorded — monitor mode for onboarding.
              </p>
            </div>
            <Switch
              checked={blockOnViolation}
              onCheckedChange={(v) => setValue('blockOnViolation', v, { shouldDirty: true })}
              aria-label="Block on violation"
            />
          </div>

          {/* keep RHF registered even though we drive via setValue */}
          <input type="hidden" {...register('securityThreshold')} />

          <Button type="submit" disabled={isSubmitting || saveMutation.isPending}>
            {saveMutation.isPending ? 'Saving...' : 'Save Compliance Policy'}
          </Button>
        </form>
      </CardContent>
    </Card>
  )
}

const PLUGIN_LABEL: Record<EnforceablePlugin, string> = {
  'pii-filter': 'PII filter',
  'security-scanner': 'Security scanner',
}

function ComplianceReportCard() {
  const { error } = useNotifications()
  const [range, setRange] = useState<'7' | '30' | '90'>('30')

  const params = useMemo(() => {
    const to = new Date()
    const from = new Date(to.getTime() - Number(range) * 24 * 60 * 60 * 1000)
    return { from: from.toISOString(), to: to.toISOString() }
  }, [range])

  const { data, isLoading, isError, refetch, isFetching } = useQuery<ComplianceReport>({
    queryKey: ['compliance-report', range],
    queryFn: () => complianceApi.getReport(params),
  })

  const downloadReport = () => {
    if (!data) return
    try {
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = `compliance-report-${range}d.json`
      a.click()
      URL.revokeObjectURL(url)
    } catch {
      error('Download failed', 'Could not export the report.')
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <FileBarChart className="h-5 w-5 text-primary" /> Compliance Report
          </CardTitle>
          <CardDescription>
            Posture scored from your enforced controls over audit activity.
          </CardDescription>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Select value={range} onValueChange={(v) => setRange(v as '7' | '30' | '90')}>
            <SelectTrigger className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="7">Last 7 days</SelectItem>
              <SelectItem value="30">Last 30 days</SelectItem>
              <SelectItem value="90">Last 90 days</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {isLoading ? (
          <div className="py-8 text-center text-muted-foreground">Generating report...</div>
        ) : isError || !data ? (
          <div className="py-8 text-center space-y-3">
            <p className="text-sm text-muted-foreground">Could not load the compliance report.</p>
            <Button variant="outline" onClick={() => refetch()}>
              Retry
            </Button>
          </div>
        ) : (
          <>
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label>Posture score</Label>
                <span className="text-2xl font-heading font-bold tabular-nums">
                  {data.postureScore}
                  <span className="text-sm font-normal text-muted-foreground">/100</span>
                </span>
              </div>
              <Progress value={data.postureScore} />
            </div>

            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              <Stat label="Total events" value={data.activity.totalEvents} />
              <Stat label="Scannable" value={data.activity.scannableEvents} />
              <Stat label="Credential access" value={data.activity.credentialAccessEvents} />
              <Stat
                label="Controls enforced"
                value={data.enforcedControls.filter((c) => c.enforced).length}
              />
            </div>

            <div>
              <Label className="mb-2 block">Enforced controls</Label>
              <div className="overflow-x-auto rounded-md border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Control</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead>Key settings</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {data.enforcedControls.map((c) => (
                      <TableRow key={c.plugin}>
                        <TableCell className="font-medium">{PLUGIN_LABEL[c.plugin]}</TableCell>
                        <TableCell>
                          {c.enforced ? (
                            <Badge className="bg-primary/15 text-primary border-primary/40" variant="outline">
                              Enforced
                            </Badge>
                          ) : (
                            <Badge variant="outline" className="text-muted-foreground">
                              Not enforced
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs text-muted-foreground">
                          {c.plugin === 'security-scanner'
                            ? `threshold: ${c.settings.severityThreshold} · block: ${c.settings.blockOnThreat}`
                            : `categories: ${
                                Array.isArray(c.settings.categories)
                                  ? c.settings.categories.join(', ')
                                  : c.settings.categories
                              }`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Window: {new Date(data.window.from).toLocaleDateString()} –{' '}
                {new Date(data.window.to).toLocaleDateString()}
              </p>
              <div className="flex items-center gap-2">
                <Button variant="ghost" onClick={() => refetch()} disabled={isFetching}>
                  {isFetching ? 'Refreshing...' : 'Refresh'}
                </Button>
                <Button variant="outline" onClick={downloadReport}>
                  Download JSON
                </Button>
              </div>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  )
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-md border p-3">
      <div className="text-2xl font-heading font-semibold tabular-nums">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  )
}
