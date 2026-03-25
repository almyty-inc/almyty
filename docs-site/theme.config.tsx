import { DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: <span style={{ fontWeight: 800 }}>almyty docs</span>,
  project: { link: 'https://github.com/frane/almyty' },
  docsRepositoryBase: 'https://github.com/frane/almyty/tree/main/docs-site',
  footer: { text: 'almyty — The open platform for AI agents' },
  useNextSeoProps() {
    return { titleTemplate: '%s – almyty docs' }
  },
  primaryHue: 263,
}

export default config
