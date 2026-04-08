import { BadRequestException } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { validateUrl } from '../../../common/security/url-validator';

/**
 * Single entry point for every outbound HTTP call to an LLM
 * provider. Every `callOpenAI` / `callAnthropic` / `callGoogle` /
 * `callCohere` / `callHuggingFace` / `callCustomProvider` path, plus
 * the model-discovery helpers in `llm-providers.service`, routes
 * through this helper instead of calling `axios` directly.
 *
 * Why it exists: provider URLs come from `provider.getApiUrl()`,
 * which is user-supplied at provider-save time. Without a gate, a
 * user could create a "Custom" or "OpenAI-compat" provider with
 * apiUrl set to:
 *
 *   http://169.254.169.254/...      (AWS metadata service)
 *   http://localhost:6379/...       (internal Redis)
 *   http://127.0.0.1:4000/_admin    (loopback service)
 *   http://[::1]/...                (IPv6 loopback)
 *   file:///etc/passwd              (non-http schemes)
 *
 * …and every chat completion / model refresh would fire the
 * request at that internal endpoint with the provider's real
 * Authorization header attached — leaking the API key plus
 * whatever the internal service responds with.
 *
 * This helper validates the outgoing URL, enforces content-size
 * caps, and disables redirects so a public endpoint can't 302
 * past the validator into an internal host.
 *
 * The function wrapper (rather than `axios.create()`) is
 * deliberate: the backend test setup replaces `axios` with a
 * simple mock object that doesn't implement `.create()`, so an
 * instance-based gate would break every spec. Routing through the
 * global `axios` function keeps the single-mock-point contract.
 */
const LLM_HTTP_DEFAULTS: AxiosRequestConfig = {
  // 20 MB is generous for streaming chat completions + tool calls
  // but caps a malicious or runaway response body.
  maxContentLength: 20 * 1024 * 1024,
  maxBodyLength: 20 * 1024 * 1024,
  // Never follow redirects across the SSRF gate. A provider that
  // legitimately 302s must be configured with its final URL.
  maxRedirects: 0,
};

export async function callLlmProviderHttp<T = any>(
  config: AxiosRequestConfig,
): Promise<AxiosResponse<T>> {
  if (!config.url) {
    throw new BadRequestException('LLM provider URL is missing');
  }

  // Resolve the full URL the way axios does: baseURL + url. We
  // don't use baseURL anywhere so this is almost always just
  // `config.url`, but handling both forms avoids a future footgun.
  let target: string;
  try {
    target = new URL(config.url, config.baseURL || undefined).toString();
  } catch {
    throw new BadRequestException(`Invalid LLM provider URL: ${config.url}`);
  }

  const validation = validateUrl(target);
  if (!validation.valid) {
    throw new BadRequestException(
      `Refused to reach LLM provider URL: ${validation.error}`,
    );
  }

  return axios({ ...LLM_HTTP_DEFAULTS, ...config });
}
