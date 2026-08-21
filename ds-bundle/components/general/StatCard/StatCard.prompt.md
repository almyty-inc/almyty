StatCard from almyty-frontend. Use via `window.AlmytyDS.StatCard` (bundle loaded from the root `_ds_bundle.js`).

## Examples

### Grid

```jsx
() => (
  <div className="grid grid-cols-2 gap-4" style={{ width: 520 }}>
    <StatCard icon={Bot} label="Active agents" value={12} />
    <StatCard icon={Wrench} label="Tools" value={148} subtitle="across 9 APIs" />
    <StatCard icon={Network} label="Gateways" value={6} />
    <StatCard icon={Activity} label="Executions (24h)" value="3,420" subtitle="+12% vs yesterday" />
  </div>
)
```

### Single

```jsx
() => (
  <div style={{ width: 260 }}>
    <StatCard icon={Activity} label="Requests (7d)" value="48,210" subtitle="99.9% success" />
  </div>
)
```
