Button from almyty-frontend. Use via `window.AlmytyDS.Button` (bundle loaded from the root `_ds_bundle.js`).

## Examples

### Variants

```jsx
() => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>Deploy agent</Button>
    <Button variant="secondary">Save draft</Button>
    <Button variant="outline">Cancel</Button>
    <Button variant="ghost">Dismiss</Button>
    <Button variant="destructive">Delete gateway</Button>
    <Button variant="link">View docs</Button>
  </div>
)
```

### Sizes

```jsx
() => (
  <div className="flex flex-wrap items-center gap-3">
    <Button size="sm">Small</Button>
    <Button size="default">Default</Button>
    <Button size="lg">Large</Button>
    <Button size="icon" aria-label="Add">
      <Plus className="h-4 w-4" />
    </Button>
  </div>
)
```

### WithIcons

```jsx
() => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>
      <Plus className="mr-2 h-4 w-4" /> New API
    </Button>
    <Button variant="destructive">
      <Trash2 className="mr-2 h-4 w-4" /> Remove
    </Button>
  </div>
)
```

### States

```jsx
() => (
  <div className="flex flex-wrap items-center gap-3">
    <Button>Enabled</Button>
    <Button disabled>Disabled</Button>
  </div>
)
```
