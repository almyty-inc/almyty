import { BadRequestException } from '@nestjs/common';
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import {
  validateUrl,
  validateUrlAllowingPrivate,
  ollamaPrivateUrlsAllowed,
} from '../../../common/security/url-validator';
import { ssrfSafeHttpAgent, ssrfSafeHttpsAgent } from '../../../common/security/ssrf-safe-agent';
import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';

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
  // DNS-pinning agents: re-validate the resolved IP so a provider name
  // that rebinds to an internal/metadata address is refused at connect.
  httpAgent: ssrfSafeHttpAgent,
  httpsAgent: ssrfSafeHttpsAgent,
};

export interface LlmCallOptions {
  /**
   * Relax the private/loopback/link-local range bans for this single
   * call. ONLY ever set through llmCallOptionsFor() — i.e. for OLLAMA
   * providers when the self-hosting escape hatch
   * OLLAMA_ALLOW_PRIVATE_URLS=true is active. Even then the URL must
   * still be a credential-free http(s) URL, redirects stay disabled,
   * and the response-size caps still apply.
   */
  allowPrivateUrls?: boolean;
}

/**
 * Per-provider SSRF posture for an outbound LLM call. Every provider
 * type gets the full validateUrl() gate; Ollama providers additionally
 * honor OLLAMA_ALLOW_PRIVATE_URLS=true (self-hosted deployments running
 * Ollama on localhost / a private network). Hosted deployments leave
 * the env unset, so tenant-supplied private URLs stay blocked.
 */
export function llmCallOptionsFor(provider: LlmProvider): LlmCallOptions {
  return {
    allowPrivateUrls:
      provider.type === LlmProviderType.OLLAMA && ollamaPrivateUrlsAllowed(),
  };
}

/** Resolve baseURL+url the way axios does and run the SSRF gate. */
function assertLlmUrlAllowed(config: AxiosRequestConfig, opts?: LlmCallOptions): void {
  if (!config.url) {
    throw new BadRequestException('LLM provider URL is missing');
  }

  let target: string;
  try {
    target = new URL(config.url, config.baseURL || undefined).toString();
  } catch {
    throw new BadRequestException(`Invalid LLM provider URL: ${config.url}`);
  }

  const validation = opts?.allowPrivateUrls
    ? validateUrlAllowingPrivate(target)
    : validateUrl(target);
  if (!validation.valid) {
    throw new BadRequestException(
      `Refused to reach LLM provider URL: ${validation.error}`,
    );
  }
}

/**
 * The DNS-pinning agents refuse connections that resolve to private
 * addresses, so when private URLs are explicitly allowed (Ollama escape
 * hatch) the request must fall back to the default agents — otherwise
 * localhost:11434 would pass the string check and then be refused at
 * connect time.
 */
function defaultsFor(opts?: LlmCallOptions): AxiosRequestConfig {
  if (opts?.allowPrivateUrls) {
    return { ...LLM_HTTP_DEFAULTS, httpAgent: undefined, httpsAgent: undefined };
  }
  return LLM_HTTP_DEFAULTS;
}

export async function callLlmProviderHttp<T = any>(
  config: AxiosRequestConfig,
  opts?: LlmCallOptions,
): Promise<AxiosResponse<T>> {
  assertLlmUrlAllowed(config, opts);
  return axios({ ...defaultsFor(opts), ...config });
}

/**
 * Streaming variant of callLlmProviderHttp. Same SSRF validation
 * and redirect policy, but returns the raw response with
 * `responseType: 'stream'` so the caller can consume SSE chunks
 * incrementally. The caller is responsible for parsing the SSE
 * format and closing the stream.
 */
export async function callLlmProviderHttpStream<T = any>(
  config: AxiosRequestConfig,
  opts?: LlmCallOptions,
): Promise<AxiosResponse<T>> {
  assertLlmUrlAllowed(config, opts);
  return axios({
    ...defaultsFor(opts),
    ...config,
    responseType: 'stream',
  });
}