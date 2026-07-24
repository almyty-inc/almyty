EmptyState from almyty-frontend. Use via `window.AlmytyDS.EmptyState` (bundle loaded from the root `_ds_bundle.js`).

## Examples

### Default

```jsx
() => (
  <div style={{ width: 560 }}>
    <EmptyState
      icon={Network}
      title="No gateways yet"
      description="Create a gateway to expose your tools over MCP, A2A, UTCP, or Skills."
      action={
        <Button>
          <Plus className="mr-2 h-4 w-4" /> New gateway
        </Button>
      }
      secondaryAction={<Button variant="outline">Read the docs</Button>}
    />
  </div>
)
```

### TitleOnly

```jsx
() => (
  <div style={{ width: 560 }}>
    <EmptyState title="No results" description="Try adjusting your filters." />
  </div>
)
```
