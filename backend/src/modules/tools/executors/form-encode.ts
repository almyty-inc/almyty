/**
 * A request body as `application/x-www-form-urlencoded`, nested the way
 * form APIs read it (Stripe among them): `metadata[order]=NW-1`,
 * `expand[0]=charge`. An operation that declares a form body was sent
 * JSON, which such an API reads as no parameters at all.
 */
export function formEncode(value: unknown): string {
  const parts: string[] = [];
  const walk = (key: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(`${key}[${i}]`, item));
      return;
    }
    if (typeof v === 'object') {
      for (const [k, inner] of Object.entries(v as Record<string, unknown>)) walk(`${key}[${k}]`, inner);
      return;
    }
    parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(String(v))}`);
  };
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(k, v);
  }
  return parts.join('&');
}

/** Whether the operation's declared body is a form, not JSON. */
export function isFormBody(operation: { parameters?: { body?: { contentType?: string } } | null } | null | undefined): boolean {
  const type = operation?.parameters?.body?.contentType;
  return typeof type === 'string' && type.toLowerCase().startsWith('application/x-www-form-urlencoded');
}
