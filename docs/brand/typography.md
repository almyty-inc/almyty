# Almyty Typography

## Font Stack

All fonts are free (SIL Open Font License) and available on Google Fonts.

| Role | Family | Weight | Letter-spacing | Tailwind |
|------|--------|--------|----------------|----------|
| Logo wordmark | Manrope | 500 | -1px | `font-heading font-medium tracking-tight` |
| Headings | Manrope | 700-800 | -0.5 to -1px | `font-heading font-bold` |
| Body | DM Sans | 400-500 | default | `font-body` |
| Code / CLI | JetBrains Mono | 400-500 | default | `font-mono` |

## Tailwind Font Config

```js
fontFamily: {
  heading: ["Manrope", "sans-serif"],
  body: ["DM Sans", "sans-serif"],
  mono: ["JetBrains Mono", "monospace"],
}
```

## Google Fonts Import

```html
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500;600;700&family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
```

## Sizing Scale

| Element | Size | Weight | Tailwind |
|---------|------|--------|----------|
| H1 (page title) | 36-48px | 800 | `text-4xl font-heading font-extrabold` |
| H2 (section) | 24-28px | 700 | `text-2xl font-heading font-bold` |
| H3 (subsection) | 18-20px | 600 | `text-lg font-heading font-semibold` |
| Body | 14-16px | 400 | `text-sm font-body` |
| Caption / label | 12px | 500 | `text-xs font-body font-medium` |
| Code | 12-14px | 400 | `text-sm font-mono` |
| Monospace label | 10-11px | 400 | `text-xs font-mono tracking-wider uppercase` |
