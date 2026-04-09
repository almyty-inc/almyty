/* Nextra 4 MDX components bridge — exports a useMDXComponents
 * hook that merges the theme's default MDX component map with
 * any project-specific overrides. For the docs site we use the
 * theme defaults as-is; this file exists because Nextra 4's
 * importPage() helper expects a root-level mdx-components module
 * to be importable.
 */
import { useMDXComponents as getThemeComponents } from 'nextra-theme-docs'

const themeComponents = getThemeComponents()

export function useMDXComponents(components: Record<string, unknown> = {}) {
  return {
    ...themeComponents,
    ...components,
  }
}
