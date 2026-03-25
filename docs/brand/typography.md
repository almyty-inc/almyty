# Almyty Typography

All fonts are free (SIL Open Font License), available on Google Fonts.

| Role | Family | Weight | Letter-spacing | Tailwind |
|------|--------|--------|----------------|----------|
| Logo wordmark | Manrope | 500 | -1px | font-heading font-medium tracking-tight |
| Headings | Manrope | 700-800 | -0.5 to -1px | font-heading font-bold |
| Body | DM Sans | 400-500 | default | font-body |
| Code | JetBrains Mono | 400-500 | default | font-mono |

Google Fonts import:
```css
@import url('https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;700&family=JetBrains+Mono:wght@400;500;600;700&family=Manrope:wght@300;400;500;600;700;800&display=swap');
```

Tailwind config:
```js
fontFamily: {
  heading: ["Manrope", "sans-serif"],
  body: ["DM Sans", "sans-serif"],
  mono: ["JetBrains Mono", "monospace"],
}
```
