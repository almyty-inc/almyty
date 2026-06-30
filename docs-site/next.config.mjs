import nextra from 'nextra'

// Nextra 4 no longer takes a theme config here — the theme is
// applied in app/layout.tsx as a React component tree. All the
// nextra() call needs is the MDX-compilation config, or can
// even be called with no args.
const withNextra = nextra({
  // Nextra 4 search is powered by Pagefind: the `postbuild` script
  // indexes the built HTML into public/_pagefind, which the search
  // component loads at runtime. codeHighlight is for the API samples.
  codeHighlight: true,
})

export default withNextra({
  // Produce a standalone server bundle so the docs image can run
  // with `node server.js` — matches the docs-site Dockerfile.
  output: 'standalone',
  reactStrictMode: true,
})
