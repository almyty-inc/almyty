# almyty logo

The lightning mark is unchanged in design system v1. Use the original
asset (`frontend/public/favicon.svg`, byte-identical to the design-system
package's `assets/almyty-flash.svg`): never retrace, stretch or recolour
it. Its gradient is the mark's own and is not the interface palette.

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

Gradient: #8b5cf6 (top) to #22d3ee (bottom), as drawn in the asset.

Circuit nodes (filled circles):
- (10,0) r=2 #a78bfa — top-left
- (20,0) r=2 #8b5cf6 — top-right
- (12,12) r=1.5 #7c3aed — inner waist (ONE dot, shared by both inner waist points)
- (6,26) r=2 #22d3ee — bottom tip

## Wordmark

Manrope 600, lowercase `almyty`, tracking -0.05em, in the solid text
colour (#141E30 light, #EDF3FC dark). No second brand name.

## Sizes

32px in the website header, 24-32px in app chrome; 20px is the practical
minimum outside favicons. Keep at least a quarter of the mark's width
clear on each side.

| Context | Icon | Wordmark |
|---------|------|----------|
| App sidebar and top bar | Yes | Yes |
| Website header | Yes | Yes |
| Favicon 48px+ | Yes (badge) | No |
| Favicon 16px | Solid cutout | No |

## Rules

- Never fill the bolt solid. Always hollow/stroke only.
- Never put the lightning emoji in the SVG.
- Never reverse the gradient direction.
- Never use the mark below 20px (use the favicon variant).