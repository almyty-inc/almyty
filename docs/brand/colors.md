# Almyty Color System

## Primary: Violet

| Step | Hex | Tailwind | Usage |
|------|-----|----------|-------|
| 50 | #f5f3ff | violet-50 | Tinted backgrounds (light) |
| 100 | #ede9fe | violet-100 | Hover states (light) |
| 200 | #ddd6fe | violet-200 | |
| 300 | #c4b5fd | violet-300 | Icon node fills, badge text (dark) |
| 400 | #a78bfa | violet-400 | Top node fill |
| 500 | #8b5cf6 | violet-500 | **Primary brand color (dark theme)** |
| 600 | #7c3aed | violet-600 | Hover state (dark) |
| 700 | #6d28d9 | violet-700 | **Primary brand color (light theme)** |
| 800 | #5b21b6 | violet-800 | |
| 900 | #4c1d95 | violet-900 | |

## Secondary: Cyan

| Step | Hex | Tailwind | Usage |
|------|-----|----------|-------|
| 50 | #ecfeff | cyan-50 | Tinted backgrounds (light) |
| 100 | #cffafe | cyan-100 | |
| 200 | #a5f3fc | cyan-200 | |
| 300 | #67e8f9 | cyan-300 | Badge text (dark) |
| 400 | #22d3ee | cyan-400 | **Accent color (dark theme)** |
| 500 | #06b6d4 | cyan-500 | |
| 600 | #0891b2 | cyan-600 | |
| 700 | #0e7490 | cyan-700 | **Accent color (light theme)** |
| 800 | #155e75 | cyan-800 | |
| 900 | #164e63 | cyan-900 | |

## Semantic Colors

| Role | Dark | Light | Usage |
|------|------|-------|-------|
| Primary | #8b5cf6 | #6d28d9 | Buttons, links, focus rings |
| Secondary | #22d3ee | #0e7490 | Accents, badges, code highlights |
| Success | #10b981 | #059669 | Connected, healthy, passing |
| Warning | #f59e0b | #d97706 | Degraded, pending |
| Destructive | #f43f5e | #e11d48 | Errors, delete, disconnected |

## Dark Theme Neutrals

| Token | Hex | Usage |
|-------|-----|-------|
| Background | #06060a | Page background |
| Surface | #0a0a0e | Cards, popovers |
| Card | #111116 | Elevated cards |
| Border | #141418 | Borders, dividers |
| Elevated | #1a1a20 | Inputs, elevated surfaces |
| Muted text | #555555 | Disabled, placeholder |
| Secondary text | #888888 | Labels, captions |
| Primary text | #d4d4d4 | Body text |

## Light Theme Neutrals

| Token | Hex | Usage |
|-------|-----|-------|
| Background | #f4f2ee | Page background |
| Surface | #ffffff | Cards |
| Border | #e0ddd8 | Borders, dividers |
| Muted text | #666666 | Disabled, placeholder |
| Primary text | #1a1816 | Body text |

## Gradients

```css
/* Icon gradient — vertical */
linear-gradient(180deg, #8b5cf6 0%, #22d3ee 100%)

/* Wordmark gradient — dark mode */
linear-gradient(90deg, #8b5cf6 0%, #8b5cf6 35%, #d4d4d4 100%)

/* Wordmark gradient — light mode */
linear-gradient(90deg, #6d28d9 0%, #6d28d9 35%, #1a1a1a 100%)

/* Background accent (hero sections) */
linear-gradient(135deg, rgba(139,92,246,0.12) 0%, rgba(34,211,238,0.06) 100%)
```

## Protocol Badge Colors

| Protocol | Tailwind bg | Tailwind text |
|----------|-------------|---------------|
| MCP | violet-500/20 | violet-300 |
| A2A | cyan-500/20 | cyan-300 |
| UTCP | emerald-500/20 | emerald-300 |
| SOAP | amber-500/20 | amber-300 |
| GraphQL | rose-500/20 | rose-300 |
| REST | blue-500/20 | blue-300 |

## shadcn/ui CSS Variables

### Dark (default)

```css
:root {
  --background: 240 20% 3.5%;
  --foreground: 0 0% 83%;
  --card: 240 18% 5%;
  --card-foreground: 0 0% 83%;
  --popover: 240 18% 5%;
  --popover-foreground: 0 0% 83%;
  --primary: 262 83% 66%;
  --primary-foreground: 0 0% 100%;
  --secondary: 187 86% 53%;
  --secondary-foreground: 0 0% 3%;
  --muted: 240 10% 10%;
  --muted-foreground: 0 0% 53%;
  --accent: 187 86% 53%;
  --accent-foreground: 0 0% 3%;
  --destructive: 350 89% 60%;
  --destructive-foreground: 0 0% 100%;
  --border: 240 10% 10%;
  --input: 240 10% 12%;
  --ring: 262 83% 66%;
  --radius: 0.5rem;
}
```

### Light

```css
.light {
  --background: 30 20% 95%;
  --foreground: 30 10% 10%;
  --card: 0 0% 100%;
  --card-foreground: 30 10% 10%;
  --primary: 263 70% 50%;
  --primary-foreground: 0 0% 100%;
  --secondary: 189 82% 31%;
  --secondary-foreground: 0 0% 100%;
  --muted: 30 10% 90%;
  --muted-foreground: 0 0% 40%;
  --border: 30 10% 88%;
  --input: 30 10% 88%;
  --ring: 263 70% 50%;
}
```
