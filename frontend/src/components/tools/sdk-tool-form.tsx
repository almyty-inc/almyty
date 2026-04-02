import React, { useState, useEffect, useMemo } from 'react'
import { ChevronDown, ChevronRight, Code } from 'lucide-react'

import { Button } from '@/components/ui/button'
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

function assemblePreview(config: any): string {
  if (!config?.packageName || !config?.construct?.className || !config?.call?.method) {
    return '// Configure the tool to see generated code'
  }

  const lines: string[] = []
  const imports = config.imports?.join(', ') || config.construct.className
  if (config.imports?.includes('default')) {
    lines.push(`const ${config.construct.className} = require('${config.packageName}');`)
  } else {
    lines.push(`const { ${imports} } = require('${config.packageName}');`)
  }
  lines.push('')

  // Constructor
  const ctorArgs = config.construct?.args
    ? config.construct.args.map((a: any) =>
      a.source === 'literal' ? JSON.stringify(a.value) :
      a.source === 'credential' ? `<credential:${a.credentialPath || '...'}>` :
      `params.${a.paramName || '...'}`
    ).join(', ')
    : '...'
  lines.push(`const client = new ${config.construct.className}(${ctorArgs});`)

  // Method call
  const chain = config.call.chain ? `.${config.call.chain.join('.')}` : ''
  const methodArgs = config.call?.args
    ? config.call.args.map((a: any) =>
      a.source === 'literal' ? JSON.stringify(a.value) :
      a.source === 'credential' ? `<credential:${a.credentialPath || '...'}>` :
      `params.${a.paramName || '...'}`
    ).join(', ')
    : '...'
  lines.push(`const result = await client${chain}.${config.call.method}(${methodArgs});`)

  if (config.responseMapping?.dataPath) {
    lines.push(`return result.${config.responseMapping.dataPath};`)
  } else {
    lines.push('return result;')
  }

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
    const colors: Record<string, string> = {
      string: 'bg-blue-100 text-blue-700',
      number: 'bg-green-100 text-green-700',
      boolean: 'bg-purple-100 text-purple-700',
      object: 'bg-amber-100 text-amber-700',
      array: 'bg-pink-100 text-pink-700',
      enum: 'bg-cyan-100 text-cyan-700',
    }
    return (
      <Badge variant="outline" className={`text-[10px] px-1.5 py-0 ${colors[kind] || 'bg-zinc-100 text-zinc-700'}`}>
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
          <SelectItem value="parameter">Tool Param</SelectItem>
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
    if (!selectedPackage || !selectedExport || !selectedMethodKey || !selectedMethodEntry) {
      onConfigChange(null)
      return
    }

    const constructArgs = (currentExport?.constructorParams || []).map((p) => {
      const val = constructorValues[p.name]
      if (!val) return { source: 'literal', value: undefined }
      return val
    })

    const methodArgs = (selectedMethodEntry.method.params || []).map((p) => {
      const val = methodArgValues[p.name]
      if (!val) return { source: 'literal', value: undefined }
      return val
    })

    const config = {
      packageName: selectedPackage,
      imports: [selectedExport],
      construct: {
        className: selectedExport,
        args: constructArgs,
      },
      call: {
        method: selectedMethodEntry.method.name,
        chain: selectedMethodEntry.chain.length > 0 ? selectedMethodEntry.chain : undefined,
        args: methodArgs,
      },
      responseMapping: dataPath ? { dataPath } : undefined,
    }

    onConfigChange(config)

    // Build tool parameters from fields marked as "parameter"
    const properties: Record<string, any> = {}
    const required: string[] = []

    // From constructor params
    ;(currentExport?.constructorParams || []).forEach((p) => {
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

    // From method args
    ;(selectedMethodEntry.method.params || []).forEach((p) => {
      const val = methodArgValues[p.name]
      if (val?.source === 'parameter') {
        const name = val.paramName || p.name
        properties[name] = buildJsonSchemaForParam(p)
        if (p.required) required.push(name)
      }
      if (val?.properties) {
        collectParamProperties(p, val, properties, required)
      }
    })

    const toolParams: any = {
      type: 'object',
      properties,
    }
    if (required.length > 0) toolParams.required = required

    onParamsChange(toolParams)
  }, [selectedPackage, selectedExport, selectedMethodKey, constructorValues, methodArgValues, dataPath, selectedMethodEntry, currentExport])

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
    if (!selectedPackage || !selectedExport || !selectedMethodEntry) return null
    const constructArgs = (currentExport?.constructorParams || []).map((p) => {
      const val = constructorValues[p.name]
      if (!val) return { source: 'literal', value: undefined }
      return val
    })
    const methodArgs = (selectedMethodEntry.method.params || []).map((p) => {
      const val = methodArgValues[p.name]
      if (!val) return { source: 'literal', value: undefined }
      return val
    })
    return {
      packageName: selectedPackage,
      imports: [selectedExport],
      construct: {
        className: selectedExport,
        args: constructArgs,
      },
      call: {
        method: selectedMethodEntry.method.name,
        chain: selectedMethodEntry.chain.length > 0 ? selectedMethodEntry.chain : undefined,
        args: methodArgs,
      },
      responseMapping: dataPath ? { dataPath } : undefined,
    }
  }, [selectedPackage, selectedExport, selectedMethodEntry, constructorValues, methodArgValues, dataPath, currentExport])

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
        <Label>Package</Label>
        <Select value={selectedPackage} onValueChange={setSelectedPackage}>
          <SelectTrigger>
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
          <Label>Class / Export</Label>
          <Select value={selectedExport} onValueChange={setSelectedExport}>
            <SelectTrigger>
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
          <Label className="text-sm font-semibold">Constructor Parameters</Label>
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
          <Label>Method</Label>
          <Select value={selectedMethodKey} onValueChange={setSelectedMethodKey}>
            <SelectTrigger>
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
                      <Badge variant="outline" className="text-[10px] px-1.5 py-0 bg-green-50 text-green-700">async</Badge>
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
          <Label className="text-sm font-semibold">Method Arguments</Label>
          <div className="space-y-2 border rounded-lg p-3 bg-muted/20">
            {selectedMethodEntry.method.params.map((param) => (
              <SdkParamField
                key={param.name}
                param={param}
                value={methodArgValues[param.name] || { source: 'parameter', paramName: param.name }}
                onChange={(val) => setMethodArgValues({ ...methodArgValues, [param.name]: val })}
              />
            ))}
          </div>
        </div>
      )}

      {/* Response mapping */}
      {selectedMethodKey && (
        <div>
          <Label>Response Data Path (optional)</Label>
          <Input
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
          <span>View Generated Code</span>
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
    const subVal = val.properties[subParam.name]
    if (subVal?.source === 'parameter') {
      const name = subVal.paramName || `${param.name}_${subParam.name}`
      properties[name] = buildJsonSchemaForParam(subParam)
      if (subParam.required) required.push(name)
    }
  }
}
