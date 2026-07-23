import { BadRequestException } from '@nestjs/common';

// Real safe-request under test; axios replaced with a callable mock so
// no request ever leaves the process.
jest.mock('axios', () => {
  const fn: any = jest.fn(() => Promise.resolve({ data: {} }));
  fn.default = fn;
  return fn;
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios');

import {
  callLlmProviderHttp,
  callLlmProviderHttpStream,
  llmCallOptionsFor,
} from '../providers/safe-request';
import { LlmProvider, LlmProviderType } from '../../../entities/llm-provider.entity';
import { LlmChatRunnerHelper } from '../llm-chat-runner.helper';
import { LlmModelsHelper } from '../llm-models.helper';
import { makeEnvelopeCryptoMock } from '../../../test/envelope-crypto.mock';

/**
 * SSRF posture for the Ollama provider type.
 *
 * Ollama normally lives on localhost/private networks — exactly what the
 * shared url-validator (correctly) refuses on hosted almyty. The
 * dedicated escape hatch OLLAMA_ALLOW_PRIVATE_URLS=true (default OFF)
 * lets self-hosters reach a machine-local server; hosted deployments
 * stay locked down. The gate is enforced at provider create/update
 * (validateProviderConfiguration) AND on every outbound call
 * (callLlmProviderHttp / callLlmProviderHttpStream).
 */

function ollamaProvider(apiUrl?: string, apiKey?: string): LlmProvider {
  const p = new LlmProvider();
  p.type = LlmProviderType.OLLAMA;
  p.configuration = { ...(apiUrl ? { apiUrl } : {}), ...(apiKey ? { apiKey } : {}) } as any;
  return p;
}

function openaiProvider(): LlmProvider {
  const p = new LlmProvider();
  p.type = LlmProviderType.OPENAI;
  p.configuration = { apiKey: 'sk-test-1234567890' } as any;
  return p;
}

const ENV_KEY = 'OLLAMA_ALLOW_PRIVATE_URLS';

describe('ollama SSRF gate', () => {
  const originalEnv = process.env[ENV_KEY];

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env[ENV_KEY];
    } else {
      process.env[ENV_KEY] = originalEnv;
    }
    (axios as jest.Mock).mockClear();
  });

  describe('llmCallOptionsFor', () => {
    it('is closed for ollama by default', () => {
      delete process.env[ENV_KEY];
      expect(llmCallOptionsFor(ollamaProvider())).toEqual({ allowPrivateUrls: false });
    });

    it('opens for ollama when OLLAMA_ALLOW_PRIVATE_URLS=true', () => {
      process.env[ENV_KEY] = 'true';
      expect(llmCallOptionsFor(ollamaProvider())).toEqual({ allowPrivateUrls: true });
    });

    it('never opens for non-ollama providers, even with the env set', () => {
      process.env[ENV_KEY] = 'true';
      expect(llmCallOptionsFor(openaiProvider())).toEqual({ allowPrivateUrls: false });
    });
  });

  describe('per-call gate (callLlmProviderHttp)', () => {
    it('rejects a private/loopback URL by default without any network call', async () => {
      delete process.env[ENV_KEY];
      const provider = ollamaProvider(); // defaults to http://localhost:11434
      await expect(
        callLlmProviderHttp(
          { method: 'POST', url: `${provider.getApiUrl()}/chat/completions` },
          llmCallOptionsFor(provider),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(axios).not.toHaveBeenCalled();
    });

    it('allows a private URL when OLLAMA_ALLOW_PRIVATE_URLS=true', async () => {
      process.env[ENV_KEY] = 'true';
      const provider = ollamaProvider();
      await callLlmProviderHttp(
        { method: 'POST', url: `${provider.getApiUrl()}/chat/completions` },
        llmCallOptionsFor(provider),
      );
      expect(axios).toHaveBeenCalledTimes(1);
      const cfg = (axios as jest.Mock).mock.calls[0][0];
      expect(cfg.url).toBe('http://localhost:11434/v1/chat/completions');
      // The DNS-pinning agents must be bypassed (they would refuse the
      // loopback resolution at connect time), but redirects stay off.
      expect(cfg.httpAgent).toBeUndefined();
      expect(cfg.httpsAgent).toBeUndefined();
      expect(cfg.maxRedirects).toBe(0);
    });

    it('allows public URLs with the gate closed (no env needed)', async () => {
      delete process.env[ENV_KEY];
      const provider = ollamaProvider('https://ollama.example.com');
      await callLlmProviderHttp(
        { method: 'GET', url: `${provider.getOllamaBaseUrl()}/api/tags` },
        llmCallOptionsFor(provider),
      );
      expect(axios).toHaveBeenCalledTimes(1);
    });

    it('still refuses non-http(s) schemes and embedded credentials with the gate open', async () => {
      process.env[ENV_KEY] = 'true';
      await expect(
        callLlmProviderHttp({ url: 'file:///etc/passwd' }, { allowPrivateUrls: true }),
      ).rejects.toThrow(BadRequestException);
      await expect(
        callLlmProviderHttp({ url: 'http://user:pass@localhost:11434/v1' }, { allowPrivateUrls: true }),
      ).rejects.toThrow(BadRequestException);
      expect(axios).not.toHaveBeenCalled();
    });

    it('keeps the full gate for other providers even when the ollama env is set', async () => {
      process.env[ENV_KEY] = 'true';
      await expect(
        callLlmProviderHttp(
          { method: 'POST', url: 'http://169.254.169.254/v1/chat/completions' },
          llmCallOptionsFor(openaiProvider()),
        ),
      ).rejects.toThrow(BadRequestException);
      expect(axios).not.toHaveBeenCalled();
    });

    it('applies the same gate to the streaming variant', async () => {
      delete process.env[ENV_KEY];
      await expect(
        callLlmProviderHttpStream(
          { method: 'POST', url: 'http://127.0.0.1:11434/v1/chat/completions' },
          { allowPrivateUrls: false },
        ),
      ).rejects.toThrow(BadRequestException);

      process.env[ENV_KEY] = 'true';
      await callLlmProviderHttpStream(
        { method: 'POST', url: 'http://127.0.0.1:11434/v1/chat/completions' },
        llmCallOptionsFor(ollamaProvider()),
      );
      expect(axios).toHaveBeenCalledTimes(1);
      expect((axios as jest.Mock).mock.calls[0][0].responseType).toBe('stream');
    });
  });

  describe('create/update-time validation (validateProviderConfiguration)', () => {
    const runner = new LlmChatRunnerHelper({} as any, {} as any, new LlmModelsHelper(makeEnvelopeCryptoMock()), makeEnvelopeCryptoMock());

    it('allows a keyless ollama provider with a public URL', () => {
      delete process.env[ENV_KEY];
      expect(() =>
        runner.validateProviderConfiguration(LlmProviderType.OLLAMA, {
          apiUrl: 'https://ollama.example.com',
        } as any),
      ).not.toThrow();
    });

    it('rejects the default localhost URL when the escape hatch is off', () => {
      delete process.env[ENV_KEY];
      expect(() =>
        runner.validateProviderConfiguration(LlmProviderType.OLLAMA, {} as any),
      ).toThrow(/OLLAMA_ALLOW_PRIVATE_URLS/);
    });

    it('rejects an explicit private-network URL when the escape hatch is off', () => {
      delete process.env[ENV_KEY];
      expect(() =>
        runner.validateProviderConfiguration(LlmProviderType.OLLAMA, {
          apiUrl: 'http://192.168.1.50:11434',
        } as any),
      ).toThrow(BadRequestException);
    });

    it('allows private URLs when OLLAMA_ALLOW_PRIVATE_URLS=true', () => {
      process.env[ENV_KEY] = 'true';
      expect(() =>
        runner.validateProviderConfiguration(LlmProviderType.OLLAMA, {} as any),
      ).not.toThrow();
      expect(() =>
        runner.validateProviderConfiguration(LlmProviderType.OLLAMA, {
          apiUrl: 'http://192.168.1.50:11434',
        } as any),
      ).not.toThrow();
    });

    it('still rejects garbage URLs with the escape hatch on', () => {
      process.env[ENV_KEY] = 'true';
      expect(() =>
        runner.validateProviderConfiguration(LlmProviderType.OLLAMA, {
          apiUrl: 'not a url',
        } as any),
      ).toThrow(BadRequestException);
    });

    it('keyless create stays forbidden for key-requiring providers (openai)', () => {
      process.env[ENV_KEY] = 'true';
      expect(() =>
        runner.validateProviderConfiguration(LlmProviderType.OPENAI, {} as any),
      ).toThrow(/requires an API key/);
    });
  });
});
