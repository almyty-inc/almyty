# almyty typography

Design system v1: Manrope for everything (interface, headings, website),
JetBrains Mono for code. Both are SIL Open Font License, loaded from
Google Fonts with the real weights 400, 500, 600, 700 and 800; do not rely
on synthetic in-between weights.

| Role | Size / line height | Weight | Tracking | Tailwind |
|------|--------------------|--------|----------|----------|
| Website display | 44-100px fluid / 1.04 | 800 | -0.055em | |
| Website body | 18px / 1.7 | 400 | 0 | |
| App page title | 28px / 36px | 700 | -0.03em | `PAGE_TITLE_CLASSES` |
| Section title | 20px / 28px | 600 | -0.02em | `CardTitle` |
| Interface body | 14px / 22px | 400 | 0 | `text-sm` |
| Long-form body | 16px / 24px | 400 | 0 | `text-base` |
| Control label | 14px / 20px | 600 | 0 | button, label |
| Metadata | 12px / 18px | 500 | 0 | `text-xs` |
| Code | 13px / 22px | 400 | 0 | `font-mono` |
| Logo wordmark | 22px (app) | 600 | -0.05em | `font-heading font-semibold` |

Never shrink metadata below 12px to fit a table. Use sentence case, and
tabular numbers for aligned costs, counts and timestamps. Long paragraphs
keep a 65ch measure.

Google Fonts import (`frontend/src/index.css`):
```css
@import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Manrope:wght@400;500;600;700;800&display=swap');
```

Tailwind config:
```js
fontFamily: {
  heading: ["Manrope", "system-ui", "sans-serif"],
  body: ["Manrope", "system-ui", "sans-serif"],
  sans: ["Manrope", "system-ui", "sans-serif"],
  mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
}
```