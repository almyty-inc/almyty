import React, { useState, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, Code } from 'lucide-react'

import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import type { SdkMap, SdkExport, SdkMethod, SdkParam, SdkType, SdkProperty } from '@/types'

// ── Types ──

type ParamSource = 'parameter' | 'literal' | 'credential'

interface ParamValue {
  source: ParamSource
  value?: any
  paramName?: string
  credentialPath?: string
  properties?: Record<string, ParamValue>
}

interface SdkToolFormProps {
  sdkMaps: Record<string, SdkMap>
  onConfigChange: (config: any) => void
  onParamsChange: (params: any) => void
}

// ── Helpers ──

function sdkTypeToJsonSchemaType(t: SdkType): string {
  switch (t.kind) {
    case 'string': return 'string'
    case 'number': return 'number'
    case 'boolean': return 'boolean'
    case 'array': return 'array'
    case 'enum': return 'string'
    case 'object':
    case 'class_ref':
      return 'object'
    default: return 'string'
  }
}

function buildJsonSchemaForParam(param: SdkParam): any {
  const schema: any = { type: sdkTypeToJsonSchemaType(param.type) }
  if (param.description) schema.description = param.description
  if (param.type.kind === 'enum' && param.type.enumValues) {
    schema.enum = param.type.enumValues
  }
  if (param.type.kind === 'array' && param.type.itemType) {
    schema.items = { type: sdkTypeToJsonSchemaType(param.type.itemType) }
  }
  if ((param.type.kind === 'object' || param.type.kind === 'class_ref') && param.type.properties) {
    schema.properties = {}
    const req: string[] = []
    for (const prop of param.type.properties) {
      schema.properties[prop.name] = buildJsonSchemaForParam(prop)
      if (prop.required) req.push(prop.name)
    }
    if (req.length > 0) schema.required = req
  }
  return schema
}

/** An argument nobody touched is shown, and sent, as a tool parameter of its own name. */
function defaultMethodArg(param: SdkParam): ParamValue {
  return { source: 'parameter', paramName: param.name }
}

/**
 * One form value as the backend's SdkValue (`node-sandbox/types.ts`), the
 * shape SdkCodeAssemblerService renders. Undefined when nothing was given.
 */
function toSdkValue(v: ParamValue | undefined, fallbackKey: string): any | undefined {
  if (!v) return undefined
  if (v.properties && Object.keys(v.properties).length > 0) {
    const properties: Record<string, any> = {}
    for (const [k, sub] of Object.entries(v.properties)) {
      const rendered = toSdkValue(sub, `${fallbackKey}_${k}`)
      if (rendered !== undefined) properties[k] = rendered
    }
    return { type: 'object', properties }
  }
  switch (v.source) {
    case 'parameter':
      return { type: 'parameter', key: v.paramName || fallbackKey }
    case 'credential':
      return v.credentialPath ? { type: 'credential', key: v.credentialPath } : undefined
    default:
      return v.value === undefined || v.value === '' ? undefined : { type: 'literal', value: v.value }
  }
}

/** Positional arguments; trailing ones left empty are omitted, gaps become null. */
function toSdkArgs(
  params: SdkParam[],
  values: Record<string, ParamValue>,
  defaultFor?: (p: SdkParam) => ParamValue,
): any[] {
  const args = params.map((p) => toSdkValue(values[p.name] ?? defaultFor?.(p), p.name))
  while (args.length > 0 && args[args.length - 1] === undefined) args.pop()
  return args.map((a) => a ?? { type: 'literal', value: null })
}

/**
 * The tool's `sdkConfig`, in the backend's SdkConfig shape: what
 * SdkCodeAssemblerService turns into the sandboxed call. A class is
 * constructed and its method (or chained method) called on the instance;
 * a function export is called directly; a namespace's methods through it.
 */
export function buildSdkConfig({
  map,
  exportEntry,
  methodEntry,
  constructorValues,
  methodArgValues,
  dataPath,
}: {
  map: SdkMap
  exportEntry: SdkExport
  methodEntry: { method: SdkMethod; chain: string[] }
  constructorValues: Record<string, ParamValue>
  methodArgValues: Record<string, ParamValue>
  dataPath?: string
}): any {
  // `export default` is imported as the module itself.
  const isDefault = exportEntry.name === 'default'
  const binding = isDefault ? 'SdkDefault' : exportEntry.name
  const chain = [...methodEntry.chain, methodEntry.method.name].join('.')
  const args = toSdkArgs(methodEntry.method.params || [], methodArgValues, defaultMethodArg)
  const config: any = {
    packageName: map.packageName,
    version: map.version,
    imports: [{ name: binding, isDefault }],
    call: {
      methodPath:
        exportEntry.kind === 'class'
          ? chain
          : exportEntry.kind === 'function'
            ? binding
            : `${binding}.${chain}`,
      args,
    },
  }
  if (exportEntry.kind === 'class') {
    config.construct = {
      className: binding,
      args: toSdkArgs(exportEntry.constructorParams || [], constructorValues),
    }
  }
  if (dataPath) config.responseMapping = { dataPath }
  return config
}

function previewValue(v: any): string {
  switch (v?.type) {
    case 'literal': return JSON.stringify(v.value)
    case 'parameter': return `parameters.${v.key}`
    case 'credential': return `credentials[${JSON.stringify(v.key)}]`
    case 'object':
      return `{ ${Object.entries(v.properties || {}).map(([k, sub]) => `${k}: ${previewValue(sub)}`).join(', ')} }`
    default: return 'undefined'
  }
}

/** The code the backend assembles from `config`, for the preview. */
export function assemblePreview(config: any): string {
  if (!config?.packageName || !config?.call?.methodPath) {
    return '// Configure the tool to see generated code'
  }
  const lines: string[] = []
  const imports: Array<{ name: string; isDefault: boolean }> = config.imports || []
  for (const imp of imports.filter((i) => i.isDefault)) {
    lines.push(`const ${imp.name} = require('${config.packageName}');`)
  }
  const named = imports.filter((i) => !i.isDefault).map((i) => i.name)
  if (named.length > 0) lines.push(`const { ${named.join(', ')} } = require('${config.packageName}');`)
  lines.push('')
  if (config.construct) {
    lines.push(`const client = new ${config.construct.className}(${(config.construct.args || []).map(previewValue).join(', ')});`)
  }
  const target = config.construct ? `client.${config.call.methodPath}` : config.call.methodPath
  lines.push(`const result = await ${target}(${(config.call.args || []).map(previewValue).join(', ')});`)
  lines.push(config.responseMapping?.dataPath ? `return result.${config.responseMapping.dataPath};` : 'return result;')
  return lines.join('\n')
}

// ── SdkParamField component ──

function SdkParamField({ param, value, onChange, depth = 0 }: {
  param: SdkParam
  value: ParamValue
  onChange: (value: ParamValue) => void
  depth?: number
}) {
  const [expanded, setExpanded] = useState(depth < 1)
  const isObject = param.type.kind === 'object' || param.type.kind === 'class_ref'

  const kindBadge = (kind: string) => {
    // Dark-mode aware palette. Each entry pairs a light-mode
    // tinted bg+text with a dark-mode semi-transparent bg + the
    // -300 text step — matches the protocol badge pattern from
    // docs/brand/colors.md so these parameter badges look native
    // alongside MCP/A2A/UTCP badges elsewhere in the UI.
    const colors: Record<string, string> = {
      string: 'bg-blue-100 text-blue-700 dark:bg-blue-500/20 dark:text-blue-300',
      number: 'bg-green-100 text-green-700 dark:bg-green-500/20 dark:text-green-300',
      boolean: 'bg-purple-100 text-purple-700 dark:bg-purple-500/20 dark:text-purple-300',
      object: 'bg-amber-100 text-amber-700 dark:bg-amber-500/20 dark:text-amber-300',
      array: 'bg-pink-100 text-pink-700 dark:bg-pink-500/20 dark:text-pink-300',
      enum: 'bg-cyan-100 text-cyan-700 dark:bg-cyan-500/20 dark:text-cyan-300',
    }
    return (
      <Badge
        variant="outline"
        className={`text-[10px] px-1.5 py-0 ${
          colors[kind] || 'bg-muted text-muted-foreground'
        }`}
      >
        {kind}
      </Badge>
    )
  }

  if (isObject && param.type.properties && depth < 2) {
    return (
      <div className="border rounded-md" style={{ marginLeft: depth * 12 }}>
        <button
          type="button"
          className="flex items-center gap-2 w-full p-2 text-sm hover:bg-muted/50"
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
          <span className="font-medium">{param.name}</span>
          {kindBadge(param.type.kind)}
          {param.required && <span className="text-red-500 text-xs">*</span>}
          {param.description && <span className="text-xs text-muted-foreground truncate ml-1">{param.description}</span>}
        </button>
        {expanded && (
          <div className="p-2 pt-0 space-y-2">
            {param.type.properties.map((subParam) => (
              <SdkParamField
                key={subParam.name}
                param={subParam}
                value={value.properties?.[subParam.name] || { source: 'literal' }}
                onChange={(subValue) => {
                  onChange({
                    ...value,
                    source: 'literal',
                    properties: { ...(value.properties || {}), [subParam.name]: subValue },
                  })
                }}
                depth={depth + 1}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="flex items-center gap-2" style={{ marginLeft: depth * 12 }}>
      <div className="flex items-center gap-1.5 min-w-[140px]">
        <span className="text-sm font-medium">{param.name}</span>
        {kindBadge(param.type.kind)}
        {param.required && <span className="text-red-500 text-xs">*</span>}
      </div>
      <Select
        value={value.source}
        onValueChange={(v) => onChange({ ...value, source: v as ParamSource })}
      >
        <SelectTrigger className="h-7 w-[120px] text-xs">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value="parameter">Tool param</SelectItem>
          <SelectItem value="literal">Hardcoded</SelectItem>
          <SelectItem value="credential">Credential</SelectItem>
        </SelectContent>
      </Select>
      {value.source === 'parameter' && (
        <Input
          className="h-7 text-sm flex-1"
          placeholder="Parameter name"
          value={value.paramName || ''}
          onChange={(e) => onChange({ ...value, paramName: e.target.value })}
        />
      )}
      {value.source === 'literal' && (
        param.type.kind === 'enum' && param.type.enumValues ? (
          <Select
            value={value.value || ''}
            onValueChange={(v) => onChange({ ...value, value: v })}
          >
            <SelectTrigger className="h-7 text-sm flex-1">
              <SelectValue placeholder="Select value" />
            </SelectTrigger>
            <SelectContent>
              {param.type.enumValues.map((ev) => (
                <SelectItem key={ev} value={ev}>{ev}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : param.type.kind === 'boolean' ? (
          <Select
            value={value.value?.toString() || 'false'}
            onValueChange={(v) => onChange({ ...value, value: v === 'true' })}
          >
            <SelectTrigger className="h-7 text-sm flex-1">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="true">true</SelectItem>
              <SelectItem value="false">false</SelectItem>
            </SelectContent>
          </Select>
        ) : (
          <Input
            className="h-7 text-sm flex-1"
            placeholder={param.type.kind === 'number' ? '0' : 'Value'}
            type={param.type.kind === 'number' ? 'number' : 'text'}
            value={value.value ?? ''}
            onChange={(e) => onChange({ ...value, value: param.type.kind === 'number' ? Number(e.target.value) : e.target.value })}
          />
        )
      )}
      {value.source === 'credential' && (
        <Input
          className="h-7 text-sm flex-1"
          placeholder="credentialName.field"
          value={value.credentialPath || ''}
          onChange={(e) => onChange({ ...value, credentialPath: e.target.value })}
        />
      )}
    </div>
  )
}

// ── Utility: collect methods from a class or its properties ──

function collectMethodsFromProperty(prop: SdkProperty, parentChain: string[]): Array<{ method: SdkMethod; chain: string[] }> {
  const results: Array<{ method: SdkMethod; chain: string[] }> = []
  const chain = [...parentChain, prop.name]
  if (prop.methods) {
    for (const m of prop.methods) {
      results.push({ method: m, chain })
    }
  }
  // Recurse into sub-properties (max 2 levels deep)
  if (prop.properties && chain.length < 3) {
    for (const sub of prop.properties) {
      results.push(...collectMethodsFromProperty(sub, chain))
    }
  }
  return results
}

// ── Main Form ──

export function SdkToolForm({ sdkMaps, onConfigChange, onParamsChange }: SdkToolFormProps) {
  const [selectedPackage, setSelectedPackage] = useState<string>('')
  const [selectedExport, setSelectedExport] = useState<string>('')
  const [selectedMethodKey, setSelectedMethodKey] = useState<string>('')
  const [constructorValues, setConstructorValues] = useState<Record<string, ParamValue>>({})
  const [methodArgValues, setMethodArgValues] = useState<Record<string, ParamValue>>({})
  const [dataPath, setDataPath] = useState('')
  const [codePreviewOpen, setCodePreviewOpen] = useState(false)

  const packageNames = Object.keys(sdkMaps)

  const currentMap = selectedPackage ? sdkMaps[selectedPackage] : null

  // Filter to class exports (primary use case for SDK tools)
  const classExports = useMemo(() => {
    if (!currentMap) return []
    return currentMap.exports.filter(e => e.kind === 'class')
  }, [currentMap])

  const currentExport: SdkExport | undefined = useMemo(() => {
    if (!currentMap || !selectedExport) return undefined
    return currentMap.exports.find(e => e.name === selectedExport)
  }, [currentMap, selectedExport])

  // Build a flat list of methods (direct + from chained properties)
  const availableMethods = useMemo(() => {
    if (!currentExport) return []
    const results: Array<{ method: SdkMethod; chain: string[]; key: string }> = []
    // Direct methods on the class
    if (currentExport.methods) {
      for (const m of currentExport.methods) {
        results.push({ method: m, chain: [], key: m.name })
      }
    }
    // Methods from properties (chained access)
    if (currentExport.properties) {
      for (const prop of currentExport.properties) {
        const chainedMethods = collectMethodsFromProperty(prop, [])
        for (const cm of chainedMethods) {
          const key = `${cm.chain.join('.')}.${cm.method.name}`
          results.push({ method: cm.method, chain: cm.chain, key })
        }
      }
    }
    return results
  }, [currentExport])

  const selectedMethodEntry = useMemo(() => {
    return availableMethods.find(m => m.key === selectedMethodKey)
  }, [availableMethods, selectedMethodKey])

  // Rebuild config and params whenever selections change
  useEffect(() => {
    if (!currentMap || !currentExport || !selectedMethodKey || !selectedMethodEntry) {
      onConfigChange(null)
      return
    }

    onConfigChange(buildSdkConfig({
      map: currentMap,
      exportEntry: currentExport,
      methodEntry: selectedMethodEntry,
      constructorValues,
      methodArgValues,
      dataPath,
    }))

    // Build tool parameters from fields marked as "parameter"
    const properties: Record<string, any> = {}
    const required: string[] = []

    // From constructor params
    ;(currentExport.kind === 'class' ? currentExport.constructorParams || [] : []).forEach((p) => {
      const val = constructorValues[p.name]
      if (val?.source === 'parameter') {
        const name = val.paramName || p.name
        properties[name] = buildJsonSchemaForParam(p)
        if (p.required) required.push(name)
      }
      // For object params, collect sub-properties marked as parameter
      if (val?.properties) {
        collectParamProperties(p, val, properties, required)
      }
    })

    // From method args (an argument nobody touched is a tool parameter, as shown)
    ;(selectedMethodEntry.method.params || []).forEach((p) => {
      const val = methodArgValues[p.name] ?? defaultMethodArg(p)
      if (val.source === 'parameter') {
        const name = val.paramName || p.name
        properties[name] = buildJsonSchemaForParam(p)
        if (p.required) required.push(name)
      }
      if (val.properties) {
        collectParamProperties(p, val, properties, required)
      }
    })

    const toolParams: any = {
      type: 'object',
      properties,
    }
    if (required.length > 0) toolParams.required = required

    onParamsChange(toolParams)
  }, [currentMap, selectedMethodKey, constructorValues, methodArgValues, dataPath, selectedMethodEntry, currentExport])

  // Reset dependent dropdowns when parent changes
  useEffect(() => {
    setSelectedExport('')
    setSelectedMethodKey('')
    setConstructorValues({})
    setMethodArgValues({})
  }, [selectedPackage])

  useEffect(() => {
    setSelectedMethodKey('')
    setConstructorValues({})
    setMethodArgValues({})
  }, [selectedExport])

  useEffect(() => {
    setMethodArgValues({})
  }, [selectedMethodKey])

  const currentConfig = useMemo(() => {
    if (!currentMap || !currentExport || !selectedMethodEntry) return null
    return buildSdkConfig({
      map: currentMap,
      exportEntry: currentExport,
      methodEntry: selectedMethodEntry,
      constructorValues,
      methodArgValues,
      dataPath,
    })
  }, [currentMap, currentExport, selectedMethodEntry, constructorValues, methodArgValues, dataPath])

  if (packageNames.length === 0) {
    return (
      <div className="text-center py-6 text-muted-foreground text-sm">
        No SDK maps found. The selected API has no analyzed packages yet.
      </div>
    )
  }

  return (
    <div className="space-y-4">
      {/* Package selector */}
      <div>
        <Label htmlFor="sdk-package">Package</Label>
        <Select value={selectedPackage} onValueChange={setSelectedPackage}>
          <SelectTrigger id="sdk-package">
            <SelectValue placeholder="Select a package" />
          </SelectTrigger>
          <SelectContent>
            {packageNames.map((name) => (
              <SelectItem key={name} value={name}>
                {name} <span className="text-muted-foreground text-xs ml-1">v{sdkMaps[name].version}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* Export selector */}
      {selectedPackage && (
        <div>
          <Label htmlFor="sdk-class-export">Class / export</Label>
          <Select value={selectedExport} onValueChange={setSelectedExport}>
            <SelectTrigger id="sdk-class-export">
              <SelectValue placeholder="Select an export" />
            </SelectTrigger>
            <SelectContent>
              {classExports.map((exp) => (
                <SelectItem key={exp.name} value={exp.name}>
                  <div className="flex items-center gap-2">
                    <span>{exp.name}</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{exp.kind}</Badge>
                  </div>
                </SelectItem>
              ))}
              {/* Also show non-class exports if user needs them */}
              {currentMap?.exports.filter(e => e.kind !== 'class').map((exp) => (
                <SelectItem key={exp.name} value={exp.name}>
                  <div className="flex items-center gap-2">
                    <span>{exp.name}</span>
                    <Badge variant="outline" className="text-[10px] px-1.5 py-0">{exp.kind}</Badge>
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {currentExport?.description && (
            <p className="text-xs text-muted-foreground mt-1">{currentExport.description}</p>
          )}
        </div>
      )}

      {/* Constructor parameters */}
      {currentExport?.constructorParams && currentExport.constructorParams.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm font-semibold">Constructor parameters</Label>
          <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
            {currentExport.constructorParams.map((param) => (
              <SdkParamField
                key={param.name}
                param={param}
                value={constructorValues[param.name] || { source: 'literal' }}
                onChange={(val) => setConstructorValues({ ...constructorValues, [param.name]: val })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Method selector */}
      {currentExport && (
        <div>
          <Label htmlFor="sdk-method">Method</Label>
          <Select value={selectedMethodKey} onValueChange={setSelectedMethodKey}>
            <SelectTrigger id="sdk-method">
              <SelectValue placeholder="Select a method" />
            </SelectTrigger>
            <SelectContent>
              {availableMethods.map((entry) => (
                <SelectItem key={entry.key} value={entry.key}>
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">
                      {entry.chain.length > 0 ? `${entry.chain.join('.')}.` : ''}{entry.method.name}()
                    </span>
                    {entry.method.isAsync && (
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-green-50 text-green-700 dark:bg-green-500/20 dark:text-green-300">async</Badge>
                    )}
                  </div>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selectedMethodEntry?.method.description && (
            <p className="text-xs text-muted-foreground mt-1">{selectedMethodEntry.method.description}</p>
          )}
        </div>
      )}

      {/* Method arguments */}
      {selectedMethodEntry && selectedMethodEntry.method.params.length > 0 && (
        <div className="space-y-2">
          <Label className="text-sm font-semibold">Method arguments</Label>
          <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
            {selectedMethodEntry.method.params.map((param) => (
              <SdkParamField
                key={param.name}
                param={param}
                value={methodArgValues[param.name] || defaultMethodArg(param)}
                onChange={(val) => setMethodArgValues({ ...methodArgValues, [param.name]: val })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Response mapping */}
      {selectedMethodKey && (
        <div>
          <Label htmlFor="sdk-response-data-path">Response data path (optional)</Label>
          <Input id="sdk-response-data-path"
            placeholder="e.g. data.items"
            value={dataPath}
            onChange={(e) => setDataPath(e.target.value)}
            className="h-8 text-sm"
          />
          <p className="text-xs text-muted-foreground mt-1">
            Dot-separated path to extract from the response object
          </p>
        </div>
      )}

      {/* Code preview */}
      <div className="border rounded-md">
        <button
          type="button"
          className="flex items-center gap-2 w-full p-3 text-sm font-medium hover:bg-muted/50"
          onClick={() => setCodePreviewOpen(!codePreviewOpen)}
        >
          <Code className="h-4 w-4" />
          <span>View generated code</span>
          {codePreviewOpen ? <ChevronDown className="h-4 w-4 ml-auto" /> : <ChevronRight className="h-4 w-4 ml-auto" />}
        </button>
        {codePreviewOpen && (
          <pre className="p-3 pt-0 text-xs font-mono bg-muted/30 overflow-x-auto whitespace-pre-wrap">
            {assemblePreview(currentConfig)}
          </pre>
        )}
      </div>
    </div>
  )
}

// Collect nested properties marked as "parameter" from object-type params
function collectParamProperties(
  param: SdkParam,
  val: ParamValue,
  properties: Record<string, any>,
  required: string[],
) {
  if (!val.properties || !param.type.properties) return
  for (const subParam of param.type.properties) {
    const subVal: ParamValue | undefined = val.properties[subParam.name]
    if (subVal?.source === 'parameter') {
      const name = subVal.paramName || `${param.name}_${subParam.name}`
      properties[name] = buildJsonSchemaForParam(subParam)
      if (subParam.required) required.push(name)
    }
  }
}
