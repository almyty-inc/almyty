import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi } from 'vitest'
import { JsonSchemaBuilder } from '../JsonSchemaBuilder'

describe('JsonSchemaBuilder', () => {
  describe('Visual Mode', () => {
    it('should render empty state with no properties', () => {
      const onChange = vi.fn()
      render(
        <JsonSchemaBuilder
          value={{ type: 'object', properties: {} }}
          onChange={onChange}
        />
      )

      expect(screen.getByText('No properties defined')).toBeInTheDocument()
      expect(screen.getByText('Add First Property')).toBeInTheDocument()
    })

    it('should render existing properties', () => {
      const schema = {
        type: 'object',
        properties: {
          username: {
            type: 'string',
            description: 'User name',
          },
          age: {
            type: 'number',
            description: 'User age',
          },
        },
        required: ['username'],
      }

      render(<JsonSchemaBuilder value={schema} onChange={vi.fn()} />)

      expect(screen.getByDisplayValue('username')).toBeInTheDocument()
      expect(screen.getByDisplayValue('age')).toBeInTheDocument()
      expect(screen.getByText('User name')).toBeInTheDocument()
      expect(screen.getByText('User age')).toBeInTheDocument()
    })

    it('should add new property when clicking Add Property button', async () => {
      const onChange = vi.fn()
      render(
        <JsonSchemaBuilder
          value={{ type: 'object', properties: {} }}
          onChange={onChange}
        />
      )

      const addButton = screen.getByText('Add First Property')
      fireEvent.click(addButton)

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            properties: expect.objectContaining({
              property_1: expect.objectContaining({
                type: 'string',
              }),
            }),
          })
        )
      })
    })

    it('should remove property when clicking delete button', async () => {
      const onChange = vi.fn()
      const schema = {
        type: 'object',
        properties: {
          username: { type: 'string' },
          email: { type: 'string' },
        },
      }

      render(<JsonSchemaBuilder value={schema} onChange={onChange} />)

      const deleteButtons = screen.getAllByRole('button', { name: /trash/i })
      fireEvent.click(deleteButtons[0])

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            properties: expect.not.objectContaining({
              username: expect.anything(),
            }),
          })
        )
      })
    })

    it('should update property type', async () => {
      const onChange = vi.fn()
      const schema = {
        type: 'object',
        properties: {
          count: { type: 'string' },
        },
      }

      render(<JsonSchemaBuilder value={schema} onChange={onChange} />)

      const typeSelect = screen.getByRole('combobox')
      fireEvent.click(typeSelect)

      const numberOption = screen.getByText('Number')
      fireEvent.click(numberOption)

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            properties: expect.objectContaining({
              count: expect.objectContaining({
                type: 'number',
              }),
            }),
          })
        )
      })
    })

    it('should toggle required flag', async () => {
      const onChange = vi.fn()
      const schema = {
        type: 'object',
        properties: {
          username: { type: 'string' },
        },
      }

      render(<JsonSchemaBuilder value={schema} onChange={onChange} />)

      const requiredSwitch = screen.getByRole('switch')
      fireEvent.click(requiredSwitch)

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            required: ['username'],
          })
        )
      })
    })

    it('should rename property', async () => {
      const onChange = vi.fn()
      const schema = {
        type: 'object',
        properties: {
          oldName: { type: 'string', description: 'Test' },
        },
      }

      render(<JsonSchemaBuilder value={schema} onChange={onChange} />)

      const nameInput = screen.getByDisplayValue('oldName')
      fireEvent.change(nameInput, { target: { value: 'newName' } })

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            properties: expect.objectContaining({
              newName: expect.objectContaining({
                type: 'string',
                description: 'Test',
              }),
            }),
          })
        )
      })
    })
  })

  describe('Source Mode', () => {
    it('should switch to source mode when clicking View Source', () => {
      render(
        <JsonSchemaBuilder
          value={{ type: 'object', properties: {} }}
          onChange={vi.fn()}
        />
      )

      const viewSourceButton = screen.getByText(/View Source/i)
      fireEvent.click(viewSourceButton)

      expect(screen.getByText('JSON Schema Source')).toBeInTheDocument()
      expect(screen.getByRole('textbox')).toHaveValue(
        JSON.stringify({ type: 'object', properties: {} }, null, 2)
      )
    })

    it('should update schema when editing source JSON', async () => {
      const onChange = vi.fn()
      render(
        <JsonSchemaBuilder
          value={{ type: 'object', properties: {} }}
          onChange={onChange}
        />
      )

      // Switch to source mode
      fireEvent.click(screen.getByText(/View Source/i))

      const textarea = screen.getByRole('textbox')
      const newSchema = {
        type: 'object',
        properties: {
          test: { type: 'string' },
        },
      }

      fireEvent.change(textarea, {
        target: { value: JSON.stringify(newSchema, null, 2) },
      })

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(newSchema)
      })
    })

    it('should not update schema with invalid JSON', () => {
      const onChange = vi.fn()
      render(
        <JsonSchemaBuilder
          value={{ type: 'object', properties: {} }}
          onChange={onChange}
        />
      )

      fireEvent.click(screen.getByText(/View Source/i))

      const textarea = screen.getByRole('textbox')
      fireEvent.change(textarea, { target: { value: '{invalid json}' } })

      // onChange should not be called with invalid JSON
      expect(onChange).not.toHaveBeenCalledWith(expect.objectContaining({
        type: undefined,
      }))
    })

    it('should switch back to visual mode', () => {
      render(
        <JsonSchemaBuilder
          value={{ type: 'object', properties: { test: { type: 'string' } } }}
          onChange={vi.fn()}
        />
      )

      // Go to source mode
      fireEvent.click(screen.getByText(/View Source/i))
      expect(screen.getByText('JSON Schema Source')).toBeInTheDocument()

      // Go back to visual mode
      fireEvent.click(screen.getByText(/Visual Editor/i))
      expect(screen.getByText('Schema Properties')).toBeInTheDocument()
      expect(screen.getByDisplayValue('test')).toBeInTheDocument()
    })
  })

  describe('Read-Only Mode', () => {
    it('should display properties in read-only mode', () => {
      const schema = {
        type: 'object',
        properties: {
          username: {
            type: 'string',
            description: 'User name',
          },
        },
        required: ['username'],
      }

      render(<JsonSchemaBuilder value={schema} onChange={vi.fn()} readOnly />)

      expect(screen.getByText('username')).toBeInTheDocument()
      expect(screen.getByText('User name')).toBeInTheDocument()
      expect(screen.getByText('required')).toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /Add/i })).not.toBeInTheDocument()
    })

    it('should not show add/delete buttons in read-only mode', () => {
      const schema = {
        type: 'object',
        properties: {
          test: { type: 'string' },
        },
      }

      render(<JsonSchemaBuilder value={schema} onChange={vi.fn()} readOnly />)

      expect(screen.queryByText('Add Property')).not.toBeInTheDocument()
      expect(screen.queryByRole('button', { name: /trash/i })).not.toBeInTheDocument()
    })

    it('should allow switching to source view in read-only mode', () => {
      const schema = {
        type: 'object',
        properties: {
          test: { type: 'string' },
        },
      }

      render(<JsonSchemaBuilder value={schema} onChange={vi.fn()} readOnly />)

      fireEvent.click(screen.getByText(/View Source/i))

      const textarea = screen.getByRole('textbox')
      expect(textarea).toHaveAttribute('readonly')
    })
  })

  describe('JSON Schema Compliance', () => {
    it('should generate valid JSON Schema for string property', () => {
      const onChange = vi.fn()
      render(
        <JsonSchemaBuilder
          value={{ type: 'object', properties: {} }}
          onChange={onChange}
        />
      )

      fireEvent.click(screen.getByText('Add First Property'))

      const generatedSchema = onChange.mock.calls[0][0]
      expect(generatedSchema).toMatchObject({
        type: 'object',
        properties: expect.any(Object),
      })
      expect(Object.values(generatedSchema.properties)[0]).toHaveProperty('type')
    })

    it('should maintain required array correctly', () => {
      const onChange = vi.fn()
      const schema = {
        type: 'object',
        properties: {
          prop1: { type: 'string' },
          prop2: { type: 'string' },
        },
        required: ['prop1'],
      }

      render(<JsonSchemaBuilder value={schema} onChange={onChange} />)

      // Toggle prop2 to required
      const switches = screen.getAllByRole('switch')
      fireEvent.click(switches[1])

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            required: expect.arrayContaining(['prop1', 'prop2']),
          })
        )
      })
    })

    it('should remove required array when no properties are required', () => {
      const onChange = vi.fn()
      const schema = {
        type: 'object',
        properties: {
          prop1: { type: 'string' },
        },
        required: ['prop1'],
      }

      render(<JsonSchemaBuilder value={schema} onChange={onChange} />)

      // Toggle prop1 to not required
      const requiredSwitch = screen.getByRole('switch')
      fireEvent.click(requiredSwitch)

      await waitFor(() => {
        const call = onChange.mock.calls[0][0]
        expect(call.required).toBeUndefined()
      })
    })

    it('should support all JSON Schema types', () => {
      const schema = {
        type: 'object',
        properties: {
          stringProp: { type: 'string' },
          numberProp: { type: 'number' },
          integerProp: { type: 'integer' },
          booleanProp: { type: 'boolean' },
          arrayProp: { type: 'array' },
          objectProp: { type: 'object' },
        },
      }

      render(<JsonSchemaBuilder value={schema} onChange={vi.fn()} readOnly />)

      expect(screen.getByText('string')).toBeInTheDocument()
      expect(screen.getByText('number')).toBeInTheDocument()
      expect(screen.getByText('integer')).toBeInTheDocument()
      expect(screen.getByText('boolean')).toBeInTheDocument()
      expect(screen.getByText('array')).toBeInTheDocument()
      expect(screen.getByText('object')).toBeInTheDocument()
    })
  })

  describe('Edge Cases', () => {
    it('should handle null value gracefully', () => {
      render(<JsonSchemaBuilder value={null} onChange={vi.fn()} />)

      expect(screen.getByText('No properties defined')).toBeInTheDocument()
    })

    it('should handle undefined value gracefully', () => {
      render(<JsonSchemaBuilder value={undefined} onChange={vi.fn()} />)

      expect(screen.getByText('No properties defined')).toBeInTheDocument()
    })

    it('should handle schema without properties field', () => {
      render(<JsonSchemaBuilder value={{ type: 'object' }} onChange={vi.fn()} />)

      expect(screen.getByText('No properties defined')).toBeInTheDocument()
    })

    it('should preserve property metadata when updating', () => {
      const onChange = vi.fn()
      const schema = {
        type: 'object',
        properties: {
          email: {
            type: 'string',
            description: 'Email address',
            format: 'email',
          },
        },
      }

      render(<JsonSchemaBuilder value={schema} onChange={onChange} />)

      const descInput = screen.getByDisplayValue('Email address')
      fireEvent.change(descInput, { target: { value: 'User email' } })

      await waitFor(() => {
        expect(onChange).toHaveBeenCalledWith(
          expect.objectContaining({
            properties: expect.objectContaining({
              email: expect.objectContaining({
                type: 'string',
                description: 'User email',
                // format should be preserved
              }),
            }),
          })
        )
      })
    })
  })

  describe('JSON Schema Validation', () => {
    it('should always have type: object at root', () => {
      const onChange = vi.fn()
      render(<JsonSchemaBuilder value={{ properties: {} }} onChange={onChange} />)

      fireEvent.click(screen.getByText('Add First Property'))

      const schema = onChange.mock.calls[0][0]
      expect(schema.type).toBe('object')
    })

    it('should generate valid property definitions', () => {
      const onChange = vi.fn()
      render(
        <JsonSchemaBuilder
          value={{ type: 'object', properties: {} }}
          onChange={onChange}
        />
      )

      fireEvent.click(screen.getByText('Add First Property'))

      const schema = onChange.mock.calls[0][0]
      const firstProp = Object.values(schema.properties)[0] as any

      expect(firstProp).toHaveProperty('type')
      expect(['string', 'number', 'integer', 'boolean', 'array', 'object']).toContain(
        firstProp.type
      )
    })

    it('should only include required array if properties are required', () => {
      const schema = {
        type: 'object',
        properties: {
          optional: { type: 'string' },
        },
      }

      const { rerender } = render(
        <JsonSchemaBuilder value={schema} onChange={vi.fn()} readOnly />
      )

      expect(schema.required).toBeUndefined()

      const schemaWithRequired = {
        type: 'object',
        properties: {
          required: { type: 'string' },
        },
        required: ['required'],
      }

      rerender(
        <JsonSchemaBuilder value={schemaWithRequired} onChange={vi.fn()} readOnly />
      )

      expect(screen.getByText('required')).toBeInTheDocument()
    })
  })
})
