Badge from almyty-frontend. Use via `window.AlmytyDS.Badge` (bundle loaded from the root `_ds_bundle.js`).

## Examples

### Variants

```jsx
() => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge>Default</Badge>
    <Badge variant="secondary">Secondary</Badge>
    <Badge variant="outline">Outline</Badge>
    <Badge variant="success">Active</Badge>
    <Badge variant="warning">Degraded</Badge>
    <Badge variant="destructive">Failed</Badge>
  </div>
)
```

### StatusExamples

```jsx
() => (
  <div className="flex flex-wrap items-center gap-2">
    <Badge variant="success">Healthy</Badge>
    <Badge variant="warning">Rate limited</Badge>
    <Badge variant="destructive">Offline</Badge>
    <Badge variant="secondary">Draft</Badge>
  </div>
)
```
