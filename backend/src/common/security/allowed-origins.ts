/**
 * The browser origins the API trusts: the dashboard and its admin panel.
 *
 * One builder for every place that asks, so CORS (main.ts), the cookie
 * CSRF check (csrf-origin.ts) and the MCP Origin check
 * (mcp/core/mcp-http-binding.ts) cannot drift apart. Built from:
 *
 *   CORS_ALLOWED_ORIGINS   comma-separated explicit list
 *   FRONTEND_URL           the primary web UI (always included)
 *   ADMIN_URL              optional admin panel (if deployed)
 *
 * plus the local dev server outside production.
 */
type Lookup = (name: string) => string | undefined | null;

export function dashboardAllowedOrigins(get: Lookup, nodeEnv: string | undefined = process.env.NODE_ENV): Set<string> {
  const origins = new Set<string>(
    (get('CORS_ALLOWED_ORIGINS') || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );
  const frontendUrl = get('FRONTEND_URL');
  if (frontendUrl) origins.add(frontendUrl);
  const adminUrl = get('ADMIN_URL');
  if (adminUrl) origins.add(adminUrl);
  if (nodeEnv !== 'production') {
    origins.add('http://localhost:3002');
    origins.add('http://127.0.0.1:3002');
  }
  return origins;
}
