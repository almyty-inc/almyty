import nextra from 'nextra'

// Nextra 4 no longer takes a theme config here — the theme is
// applied in app/layout.tsx as a React component tree. All the
// nextra() call needs is the MDX-compilation config, or can
// even be called with no args.
const withNextra = nextra({
  // Use Nextra's default pagefind-free search for now. Enable
  // codeHighlight for the code samples in the API reference pages.
  codeHighlight: true,
})

export default withNextra({
  // Produce a standalone server bundle so the docs image can run
  // with `node server.js` — matches the docs-site Dockerfile.
  output: 'standalone',
  reactStrictMode: true,
})
