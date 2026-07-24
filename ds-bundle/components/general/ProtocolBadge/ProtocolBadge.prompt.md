ProtocolBadge from almyty-frontend. Use via `window.AlmytyDS.ProtocolBadge` (bundle loaded from the root `_ds_bundle.js`).

## Examples

### Protocols

```jsx
() => (
  <div className="flex flex-wrap items-center gap-2">
    <ProtocolBadge protocol="mcp" />
    <ProtocolBadge protocol="a2a" />
    <ProtocolBadge protocol="utcp" />
    <ProtocolBadge protocol="skills" />
    <ProtocolBadge protocol="soap" />
    <ProtocolBadge protocol="graphql" />
    <ProtocolBadge protocol="rest" />
  </div>
)
```

### Interfaces

```jsx
() => (
  <div className="flex flex-wrap items-center gap-2">
    <ProtocolBadge protocol="slack" />
    <ProtocolBadge protocol="discord" />
    <ProtocolBadge protocol="telegram" />
    <ProtocolBadge protocol="whatsapp" />
    <ProtocolBadge protocol="email" />
    <ProtocolBadge protocol="webhook" />
  </div>
)
```
