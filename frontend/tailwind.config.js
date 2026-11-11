/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: ["class"],
  content: [
    './pages/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    './app/**/*.{ts,tsx}',
    './src/**/*.{ts,tsx}',
  ],
  theme: {
    container: {
      center: true,
      padding: "2rem",
      screens: {
        "2xl": "1400px",
      },
    },
    // Merged from the design-system package's tailwind-adapter.cjs. Values
    // come from src/styles/tokens.css; do not add parallel colour names.
    extend: {
      fontFamily: {
        heading: ["Manrope", "system-ui", "sans-serif"],
        body: ["Manrope", "system-ui", "sans-serif"],
        sans: ["Manrope", "system-ui", "sans-serif"],
        mono: ["JetBrains Mono", "SFMono-Regular", "Consolas", "monospace"],
      },
      colors: {
        brand: {
          50: "#EFF6FF", 100: "#DBEAFF", 200: "#B8D5FF", 300: "#86B9FF",
          400: "#4C96FF", 500: "#2775F7", 600: "#1469EC", 700: "#105BD0",
          800: "#0F4FB3", 900: "#103E85",
        },
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        field: {
          DEFAULT: "hsl(var(--field))",
          hover: "hsl(var(--field-hover))",
        },
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
          hover: "hsl(var(--primary-hover))",
          pressed: "hsl(var(--primary-pressed))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
          hover: "hsl(var(--secondary-hover))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
          hover: "hsl(var(--destructive-hover))",
        },
        success: { DEFAULT: "var(--am-status-success-text)", subtle: "var(--am-status-success-surface)", border: "var(--am-status-success-border)" },
        warning: { DEFAULT: "var(--am-status-warning-text)", subtle: "var(--am-status-warning-surface)", border: "var(--am-status-warning-border)" },
        info: { DEFAULT: "var(--am-status-info-text)", subtle: "var(--am-status-info-surface)", border: "var(--am-status-info-border)" },
        // Beyond the adapter: the same --am-* tokens, exposed so status,
        // selection and the app surround merge with className overrides.
        danger: { DEFAULT: "var(--am-status-danger-text)", subtle: "var(--am-status-danger-surface)", border: "var(--am-status-danger-border)" },
        selection: { DEFAULT: "var(--am-selection-surface)", foreground: "var(--am-selection-text)" },
        surround: "var(--am-surface-subtle)",
        code: {
          DEFAULT: "var(--am-code-background)",
          foreground: "var(--am-code-text)",
          keyword: "var(--am-code-keyword)",
          string: "var(--am-code-string)",
          number: "var(--am-code-number)",
          comment: "var(--am-code-comment)",
        },
        chart: {
          1: "var(--am-chart-1)", 2: "var(--am-chart-2)", 3: "var(--am-chart-3)",
          4: "var(--am-chart-4)", 5: "var(--am-chart-5)", 6: "var(--am-chart-6)",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        popover: {
          DEFAULT: "hsl(var(--popover))",
          foreground: "hsl(var(--popover-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--am-radius-control)",
        md: "0.5rem",
        sm: "0.375rem",
        xl: "var(--am-radius-panel)",
        "2xl": "var(--am-radius-dialog)",
      },
      keyframes: {
        "accordion-down": {
          from: { height: 0 },
          to: { height: "var(--radix-accordion-content-height)" },
        },
        "accordion-up": {
          from: { height: "var(--radix-accordion-content-height)" },
          to: { height: 0 },
        },
      },
      animation: {
        "accordion-down": "accordion-down 0.2s ease-out",
        "accordion-up": "accordion-up 0.2s ease-out",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
}