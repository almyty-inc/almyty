import { DocsThemeConfig } from 'nextra-theme-docs'

const config: DocsThemeConfig = {
  logo: <span style={{ fontWeight: 800 }}>apifai docs</span>,
  project: { link: 'https://github.com/frane/apifai' },
  docsRepositoryBase: 'https://github.com/frane/apifai/tree/main/docs-site',
  footer: { text: 'apifai — Universal API-to-AI Tool Gateway' },
  useNextSeoProps() {
    return { titleTemplate: '%s – apifai docs' }
  },
  primaryHue: 243,
}

export default config
