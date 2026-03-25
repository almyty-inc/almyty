# Almyty Logo

## Icon construction

Hollow lightning bolt polygon, circuit style. ViewBox: 0 0 24 26.

```svg
<polygon
  points="10,0 20,0 12,12 19,12 6,26 12,12 4,12"
  fill="none"
  stroke="url(#gradient)"
  stroke-width="1.5"
  stroke-linejoin="round"
/>
```

Gradient: #8b5cf6 (top) to #22d3ee (bottom).

Circuit nodes (filled circles):
- (10,0) r=2 #a78bfa — top-left
- (20,0) r=2 #8b5cf6 — top-right
- (12,12) r=1.5 #7c3aed — inner waist (ONE dot, shared by both inner waist points)
- (6,26) r=2 #22d3ee — bottom tip

## Wordmark

Manrope 500, lowercase `almyty`, letter-spacing -1px.
- Dark gradient: #8b5cf6 at 0-35% to #d4d4d4 at 100%
- Light gradient: #7C3AED at 0-35% to #18181B at 100%

Icon sized to match x-height of text. Tight gap.

## Usage

| Context | Icon | Wordmark | Lightning emoji |
|---------|------|----------|-----------------|
| Enterprise | Yes | Yes | No |
| Community | Yes | Yes | Yes, in text |
| Favicon 48px+ | Yes (badge) | No | No |
| Favicon 16px | Solid cutout | No | No |

## Rules

- Never fill the bolt solid. Always hollow/stroke only.
- Never put the lightning emoji in the SVG.
- Never reverse the gradient direction.
- Never use below 24px (use favicon variant).
- Minimum clear space: 1x icon width on all sides.
