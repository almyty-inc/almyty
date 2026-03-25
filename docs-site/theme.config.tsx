import { DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: <span style={{ fontWeight: 800 }}>almyty docs</span>,
  project: { link: 'https://github.com/frane/almyty' },
  docsRepositoryBase: 'https://github.com/frane/almyty/tree/main/docs-site',
  footer: { text: 'almyty — Universal API-to-AI Tool Gateway' },
  useNextSeoProps() {
    return { titleTemplate: '%s – almyty docs' }
  },
  primaryHue: 243,
}

export default config
