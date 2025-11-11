import React, { useState } from 'react'
import { Plus, Trash2, Code } from 'lucide-react'
import { Button } from './ui/button'
import { Input } from './ui/input'
import { Label } from './ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from './ui/select'
import { Switch } from './ui/switch'
import { Tabs, TabsContent, TabsList, TabsTrigger } from './ui/tabs'
import { Textarea } from './ui/textarea'

interface JsonSchemaBuilderProps {
  value: any
  onChange: (schema: any) => void
  readOnly?: boolean
}

interface Property {
  name: string
  type: string
  description?: string
  required?: boolean
  enum?: string[]
  format?: string
}

export function JsonSchemaBuilder({ value, onChange, readOnly = false }: JsonSchemaBuilderProps) {
  const [viewMode, setViewMode] = useState<'visual' | 'source'>('visual')
  const [sourceText, setSourceText] = useState(JSON.stringify(value || { type: 'object', properties: {} }, null, 2))

  // Parse schema to properties array
  const schema = value || { type: 'object', properties: {} }
  const properties: Property[] = Object.entries(schema.properties || {}).map(([name, prop]: [string, any]) => ({
    name,
    type: prop.type || 'string',
    description: prop.description,
    required: schema.required?.includes(name),
    enum: prop.enum,
    format: prop.format,
  }))

  const addProperty = () => {
    const newProperties = {
      ...schema.properties,
      [`property_${Object.keys(schema.properties || {}).length + 1}`]: {
        type: 'string',
        description: '',
      },
    }
    onChange({ ...schema, properties: newProperties })
  }

  const removeProperty = (name: string) => {
    const { [name]: removed, ...remaining } = schema.properties
    const newRequired = schema.required?.filter((r: string) => r !== name)
    onChange({
      ...schema,
      properties: remaining,
      required: newRequired?.length > 0 ? newRequired : undefined,
    })
  }

  const updateProperty = (oldName: string, updates: Partial<Property>) => {
    const prop = schema.properties[oldName]
    const newProp = {
      type: updates.type || prop.type,
      description: updates.description !== undefined ? updates.description : prop.description,
      enum: updates.enum,
      format: updates.format,
    }

    // Clean up undefined fields
    if (!newProp.description) delete newProp.description
    if (!newProp.enum) delete newProp.enum
    if (!newProp.format) delete newProp.format

    let newProperties = { ...schema.properties }

    // If name changed, rename the property
    if (updates.name && updates.name !== oldName) {
      delete newProperties[oldName]
      newProperties[updates.name] = newProp
    } else {
      newProperties[oldName] = newProp
    }

    // Handle required field
    let newRequired = schema.required || []
    if (updates.required !== undefined) {
      const propName = updates.name || oldName
      if (updates.required && !newRequired.includes(propName)) {
        newRequired = [...newRequired, propName]
      } else if (!updates.required) {
        newRequired = newRequired.filter((r: string) => r !== propName && r !== oldName)
      }
    }

    onChange({
      ...schema,
      properties: newProperties,
      required: newRequired.length > 0 ? newRequired : undefined,
    })
  }

  const handleSourceChange = (text: string) => {
    setSourceText(text)
    try {
      const parsed = JSON.parse(text)
      onChange(parsed)
    } catch {
      // Invalid JSON, don't update
    }
  }

  if (readOnly && viewMode === 'visual') {
    return (
      <div className="space-y-4">
        <div className="flex justify-between items-center">
          <h4 className="text-sm font-medium">Schema Properties</h4>
          <Button variant="ghost" size="sm" onClick={() => setViewMode('source')}>
            <Code className="h-4 w-4 mr-1" />
            View Source
          </Button>
        </div>
        {properties.length === 0 ? (
          <p className="text-sm text-muted-foreground">No parameters</p>
        ) : (
          <div className="space-y-2">
            {properties.map((prop) => (
              <div key={prop.name} className="border rounded-lg p-3 bg-muted/50">
                <div className="flex items-center justify-between mb-1">
                  <code className="text-sm font-semibold">{prop.name}</code>
                  <div className="flex items-center gap-2">
                    <span className="text-xs bg-background px-2 py-1 rounded">{prop.type}</span>
                    {prop.required && <span className="text-xs bg-red-100 text-red-700 px-2 py-1 rounded">required</span>}
                  </div>
                </div>
                {prop.description && (
                  <p className="text-xs text-muted-foreground">{prop.description}</p>
                )}
                {prop.enum && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Options: {prop.enum.join(', ')}
                  </p>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  if (viewMode === 'source') {
    return (
      <div className="space-y-2">
        <div className="flex justify-between items-center">
          <Label>JSON Schema Source</Label>
          <Button variant="ghost" size="sm" onClick={() => setViewMode('visual')}>
            Visual Editor
          </Button>
        </div>
        <Textarea
          value={sourceText}
          onChange={(e) => handleSourceChange(e.target.value)}
          className="font-mono text-xs"
          rows={12}
          readOnly={readOnly}
        />
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex justify-between items-center">
        <Label>Schema Properties</Label>
        <div className="flex gap-2">
          <Button variant="ghost" size="sm" onClick={() => setViewMode('source')}>
            <Code className="h-4 w-4 mr-1" />
            View Source
          </Button>
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={addProperty}>
              <Plus className="h-4 w-4 mr-1" />
              Add Property
            </Button>
          )}
        </div>
      </div>

      {properties.length === 0 ? (
        <div className="border-2 border-dashed rounded-lg p-8 text-center">
          <p className="text-sm text-muted-foreground mb-4">No properties defined</p>
          {!readOnly && (
            <Button variant="outline" size="sm" onClick={addProperty}>
              <Plus className="h-4 w-4 mr-1" />
              Add First Property
            </Button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {properties.map((prop) => (
            <div key={prop.name} className="border rounded-lg p-4 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label className="text-xs">Property Name</Label>
                  <Input
                    value={prop.name}
                    onChange={(e) => updateProperty(prop.name, { name: e.target.value })}
                    placeholder="property_name"
                    className="font-mono"
                    disabled={readOnly}
                  />
                </div>
                <div>
                  <Label className="text-xs">Type</Label>
                  <Select
                    value={prop.type}
                    onValueChange={(value) => updateProperty(prop.name, { type: value })}
                    disabled={readOnly}
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="string">String</SelectItem>
                      <SelectItem value="number">Number</SelectItem>
                      <SelectItem value="integer">Integer</SelectItem>
                      <SelectItem value="boolean">Boolean</SelectItem>
                      <SelectItem value="array">Array</SelectItem>
                      <SelectItem value="object">Object</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div>
                <Label className="text-xs">Description</Label>
                <Input
                  value={prop.description || ''}
                  onChange={(e) => updateProperty(prop.name, { description: e.target.value })}
                  placeholder="Describe this parameter"
                  disabled={readOnly}
                />
              </div>

              <div className="flex items-center justify-between">
                <div className="flex items-center space-x-2">
                  <Switch
                    checked={prop.required || false}
                    onCheckedChange={(checked) => updateProperty(prop.name, { required: checked })}
                    disabled={readOnly}
                  />
                  <Label className="text-xs">Required</Label>
                </div>
                {!readOnly && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => removeProperty(prop.name)}
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
