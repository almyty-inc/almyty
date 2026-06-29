/* Nextra 4 root layout — replaces the Nextra 2 theme.config.tsx.
 *
 * In Nextra 4 the theme is applied as a React component tree
 * inside app/layout.tsx rather than via a global config object.
 * The Layout component from nextra-theme-docs renders the
 * sidebar + navbar + content area; everything it needs comes
 * from the page map (auto-discovered from content/) and the
 * Navbar/Footer props below.
 */
import { Footer, Layout, Navbar } from 'nextra-theme-docs'
import { Head } from 'nextra/components'
import { getPageMap } from 'nextra/page-map'
import 'nextra-theme-docs/style.css'

export const metadata = {
  metadataBase: new URL('https://docs.almyty.com'),
  title: {
    default: 'almyty docs',
    template: '%s – almyty docs',
  },
  description: 'almyty — the open platform for AI agents',
  openGraph: {
    title: 'almyty docs',
    description: 'The open platform for AI agents',
    url: 'https://docs.almyty.com',
    siteName: 'almyty',
  },
}

const navbar = (
  <Navbar
    logo={<span style={{ fontWeight: 800 }}>almyty docs</span>}
    projectLink="https://github.com/frane/almyty"
  />
)

const footer = (
  <Footer>almyty — The open platform for AI agents</Footer>
)

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const pageMap = await getPageMap()
  return (
    <html lang="en" dir="ltr" suppressHydrationWarning>
      <Head />
      <body>
        <Layout
          navbar={navbar}
          footer={footer}
          pageMap={pageMap}
          docsRepositoryBase="https://github.com/frane/almyty/tree/main/docs-site"
          sidebar={{ defaultMenuCollapseLevel: 1 }}
        >
          {children}
        </Layout>
      </body>
    </html>
  )
}
