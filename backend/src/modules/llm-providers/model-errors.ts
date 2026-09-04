/**
 * Vendor "model does not exist" responses, normalised.
 *
 * Every vendor retires model ids on its own schedule and each says so
 * differently. Callers that keep firing a retired id (a scheduled agent,
 * a saved provider default) need one signal they can act on, not a
 * grep of the message.
 */
export const MODEL_NOT_FOUND = 'MODEL_NOT_FOUND' as const;

export class ModelNotFoundError extends Error {
  readonly code = MODEL_NOT_FOUND;
  readonly status = 404;

  constructor(
    readonly model: string,
    readonly providerId: string | undefined,
    readonly providerType: string | undefined,
    vendorMessage?: string,
  ) {
    super(
      `Model "${model}" is not available from this provider` +
        (vendorMessage ? ` (${vendorMessage})` : '') +
        '. It may have been retired; pick a current model.',
    );
    this.name = 'ModelNotFoundError';
  }
}

/**
 * Recognise a model-not-found response from any vendor we dispatch to.
 *
 *  - Anthropic:  404 {"error":{"type":"not_found_error","message":"model: claude-x"}}
 *  - OpenAI:     404 {"error":{"code":"model_not_found", ...}}
 *                400 {"error":{"message":"The model `x` does not exist ..."}}
 *  - Google:     404 {"error":{"message":"models/x is not found for API version ..."}}
 *  - Mistral:    404 {"message":"Invalid model: x"} / {"detail":"Invalid model"}
 *  - Cohere:     404 {"message":"model 'x' not found"}
 *  - Ollama:     404 {"error":"model 'x' not found"}
 */
export function isModelNotFoundResponse(status: number | undefined, body: unknown): boolean {
  if (!status || (status !== 404 && status !== 400)) return false;
  const text = bodyText(body);
  if (!text) return false;
  if (/"code"\s*:\s*"model_not_found"/i.test(text)) return true;
  if (/not_found_error/i.test(text) && /model/i.test(text)) return true;
  if (/\bmodels?\b/i.test(text) && /(not (be )?found|does not exist|is not found|invalid model|unknown model|not available|no longer (supported|available)|deprecated)/i.test(text)) {
    return true;
  }
  return false;
}

/** Best-effort extraction of the vendor's own wording, for the error message. */
export function vendorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? body.slice(0, 200) : undefined;
  const b = body as Record<string, any>;
  const m = b.error?.message ?? b.message ?? b.detail ?? (typeof b.error === 'string' ? b.error : undefined);
  return typeof m === 'string' ? m.slice(0, 200) : undefined;
}

export function isModelNotFoundError(err: unknown): err is ModelNotFoundError {
  let cur: any = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof ModelNotFoundError || cur?.code === MODEL_NOT_FOUND) return true;
    cur = cur.cause;
  }
  return false;
}


/** The ModelNotFoundError inside an error chain, if any. */
export function findModelNotFound(err: unknown): ModelNotFoundError | undefined {
  let cur: any = err;
  for (let depth = 0; cur && depth < 5; depth++) {
    if (cur instanceof ModelNotFoundError) return cur;
    cur = cur.cause;
  }
  return undefined;
}
function bodyText(body: unknown): string {
  if (body == null) return '';
  if (typeof body === 'string') return body;
  try {
    return JSON.stringify(body);
  } catch {
    return String(body);
  }
}

/**
 * The model a provider call must use. Set by the dispatch layer (which
 * resolves a vendor-listed default when nothing is configured), so by the
 * time a provider implementation runs there is always one. If there is
 * not, that is a wiring bug and we say so instead of guessing an id.
 */
export function requireModel(
  request: { model?: string },
  provider: { id?: string; type?: string; configuration?: { model?: string } },
): string {
  const model = request.model || provider.configuration?.model;
  if (model) return model;
  throw new NoModelConfiguredError(provider);
}

export class NoModelConfiguredError extends Error {
  readonly code = 'NO_MODEL_CONFIGURED';
  readonly status = 400;

  constructor(provider: { id?: string; type?: string }) {
    super(
      `No model configured for provider ${provider.id ?? provider.type ?? 'unknown'}. ` +
        'Set a model on the provider or on the agent node that uses it.',
    );
    this.name = 'NoModelConfiguredError';
  }
}
