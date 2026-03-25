# Almyty Logo

## Construction

The icon is the lightning bolt shape drawn as a **hollow polygon outline** with circuit-style thin strokes and small node dots at vertices.

### SVG polygon (normalized to viewBox "0 0 24 26")

```svg
<svg viewBox="0 0 24 26">
  <defs>
    <linearGradient id="bolt-gradient" x1="0%" y1="0%" x2="0%" y2="100%">
      <stop offset="0%" stop-color="#8b5cf6"/>
      <stop offset="100%" stop-color="#22d3ee"/>
    </linearGradient>
  </defs>
  <polygon
    points="10,0 20,0 12,12 19,12 6,26 12,12 4,12"
    fill="none"
    stroke="url(#bolt-gradient)"
    stroke-width="1.5"
    stroke-linejoin="round"
  />
  <circle cx="10" cy="0"  r="2"   fill="#a78bfa"/>
  <circle cx="20" cy="0"  r="2"   fill="#8b5cf6"/>
  <circle cx="12" cy="12" r="1.5" fill="#7c3aed"/>
  <circle cx="6"  cy="26" r="2"   fill="#22d3ee"/>
</svg>
```

### Vertices (7 points, closed polygon)

```
1. (10, 0)  — top-left peak       dot
2. (20, 0)  — top-right peak      dot
3. (12, 12) — inner waist right   dot (shared)
4. (19, 12) — outer waist right
5. (6, 26)  — bottom tip          dot
6. (12, 12) — inner waist left    (same coordinate as #3)
7. (4, 12)  — outer waist left
```

Points 3 and 6 share the same coordinate — they get ONE dot, not two.

### Stroke specifications

- Stroke width: **1.5px** (scales proportionally)
- Stroke linejoin: **round**
- Fill: **none** (always hollow, never solid)
- Node radius: **1.5-2.5px** depending on size (endpoints larger, waist smaller)

## Wordmark

- Font: **Manrope 500**
- Letter-spacing: **-1px**
- Always lowercase: `almyty`
- Gradient (dark): `#8b5cf6` at 0-35% then `#d4d4d4` at 100%
- Gradient (light): `#6d28d9` at 0-35% then `#1a1a1a` at 100%
- Positioned tight to the icon with ~6px gap

## Usage Tiers

| Context | Icon | Wordmark | Lightning emoji | Example |
|---------|------|----------|-----------------|---------|
| Enterprise / formal | Yes | Yes | No | Pitch decks, contracts, docs header |
| Community / social | Yes | Yes | Yes (in text) | GitHub README, Twitter, changelogs |
| Favicon 48px+ | Yes (in badge) | No | No | Browser tab, app icon |
| Favicon 32px | Yes (simplified) | No | No | Drop inner nodes |
| Favicon 16px | Solid cutout | No | No | Gradient badge with bolt cut out |
| Text-only | No | Yes | Optional | Inline references |

## Favicon Progressive Simplification

**48px:** Full detail — outline bolt + 4 nodes in dark rounded-rect badge
**32px:** Outline bolt, no nodes (too small to render)
**16px:** Gradient badge (violet to cyan), solid bolt shape cut out as negative space

## Clear Space

Minimum clear space around the logo = 1x the width of the icon mark on all sides.

## Do / Don't

### Do
- Use the full lockup (icon + wordmark) as default
- Use the circuit node style (thin stroke + dots)
- Keep gradient direction consistent (violet to cyan, top to bottom for icon)
- Use the 16px solid-cutout variant for favicons

### Don't
- Put the lightning emoji in the SVG logo file
- Fill the bolt polygon with solid color
- Rotate, skew, add drop shadows, or animate the logo
- Use the logo below 24px wide (use favicon variant instead)
- Reverse the gradient direction
- Add extra nodes beyond the 4 specified

## File Naming Convention

```
almyty-logo-dark.svg       — Full lockup, dark background
almyty-logo-light.svg      — Full lockup, light background
almyty-icon-48.svg         — Icon badge 48px
almyty-icon-32.svg         — Icon badge 32px (simplified)
almyty-icon-16.svg         — Favicon 16px (gradient badge + cutout)
almyty-logo-community.svg  — Lockup with lightning in text (for README)
```
