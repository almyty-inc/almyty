// Real safe-request under test; axios replaced with a callable mock so no
// request ever leaves the process. Same shape as ollama-ssrf.spec.ts.
jest.mock('axios', () => {
  const fn: any = jest.fn(() => Promise.resolve({ data: {} }));
  fn.default = fn;
  return fn;
});

// eslint-disable-next-line @typescript-eslint/no-var-requires
const axios = require('axios');

import { LlmProvider } from '../../../../entities/llm-provider.entity';
import { LlmProviderType } from '../../../../entities/llm-provider-type';
import { ScoringCallError, scoreContinuations } from '../score-continuations';
import { ResolvedScoringRoute } from '../scoring-route';

/**
 * The outbound half of the logits path.
 *
 * The thing worth testing here is not that a request is sent. It is that
 * the option's own tokens are the ones that get scored: the prefix is
 * identical across options and contributes the same constant to each, so
 * an off-by-one at the boundary does not look like an error, it looks like
 * a slightly different answer.
 */

const PREFIX = 'Classify the mail.\nAnswer: ';

function provider(): LlmProvider {
  const p = new LlmProvider();
  p.type = LlmProviderType.CUSTOM;
  p.configuration = { apiUrl: 'https://engine.example/v1' } as any;
  (p as any).getAuthHeaders = () => ({ Authorization: 'Bearer k' });
  return p;
}

const echoRoute: ResolvedScoringRoute = {
  protocol: 'openai_completions_echo',
  url: 'https://engine.example/v1/completions',
  vendorModelId: 'qwen3-8b',
};

/**
 * An echoed response for `PREFIX + optionText`.
 *
 * The prefix is three tokens and the option follows it, so `text_offset`
 * carries the byte offset of each token and the option's tokens are the
 * ones at or past the prefix length. Those offsets are the engine's own
 * account of where its tokenizer put the boundary, which is the only
 * account that cannot disagree with it.
 */
function echoed(optionText: string, optionLogprobs: number[]) {
  const prefixOffsets = [0, 10, 20];
  const prefixLogprobs = [null, -0.5, -0.5];
  const optionOffsets = optionLogprobs.map((_, i) => PREFIX.length + i);
  return {
    data: {
      choices: [
        {
          logprobs: {
            token_logprobs: [...prefixLogprobs, ...optionLogprobs],
            text_offset: [...prefixOffsets, ...optionOffsets],
          },
        },
      ],
      usage: { prompt_tokens: 3 + optionLogprobs.length },
    },
  };
}

describe('scoreContinuations: openai_completions_echo', () => {
  beforeEach(() => axios.mockReset());

  it('scores only the option tokens, not the shared prefix', async () => {
    axios
      .mockResolvedValueOnce(echoed('A) Phishing', [-0.21, -3.1, -4.6]))
      .mockResolvedValueOnce(echoed('B) Invoice', [-2.35, -0.12]));

    const result = await scoreContinuations(provider(), echoRoute, {
      prefix: PREFIX,
      options: [
        { optionId: 'A', text: 'A) Phishing' },
        { optionId: 'B', text: 'B) Invoice' },
      ],
    });

    // The three prefix logprobs are gone, including the leading null that
    // every echoed prompt carries for its first token.
    expect(result.scored).toEqual([
      { optionId: 'A', tokenLogprobs: [-0.21, -3.1, -4.6] },
      { optionId: 'B', tokenLogprobs: [-2.35, -0.12] },
    ]);
  });

  it('asks for the prompt to be echoed and nothing to be generated', async () => {
    axios.mockResolvedValue(echoed('A) Phishing', [-0.21]));

    await scoreContinuations(provider(), echoRoute, {
      prefix: PREFIX,
      options: [{ optionId: 'A', text: 'A) Phishing' }],
      temperature: 0,
      seed: 7,
    });

    const body = axios.mock.calls[0][0].data;
    expect(body).toMatchObject({
      model: 'qwen3-8b',
      prompt: `${PREFIX}A) Phishing`,
      echo: true,
      logprobs: 0,
      // The whole measurement is of the prompt. Generating even one token
      // would add latency and cost for something nothing reads.
      max_tokens: 0,
      temperature: 0,
      seed: 7,
    });
  });

  it('sends one call per option rather than a batch', async () => {
    // A batched prompt array comes back as choices associated by index. An
    // engine that reorders or drops one mislabels every option after it,
    // and the answer still looks well formed.
    axios.mockResolvedValue(echoed('x', [-1]));

    await scoreContinuations(provider(), echoRoute, {
      prefix: PREFIX,
      options: [
        { optionId: 'A', text: 'x' },
        { optionId: 'B', text: 'x' },
        { optionId: 'C', text: 'x' },
      ],
    });

    expect(axios).toHaveBeenCalledTimes(3);
    for (const call of axios.mock.calls) {
      expect(Array.isArray(call[0].data.prompt)).toBe(false);
    }
  });

  it('reports the prompt tokens it was billed for', async () => {
    axios
      .mockResolvedValueOnce(echoed('A) Phishing', [-0.21, -3.1]))
      .mockResolvedValueOnce(echoed('B) Invoice', [-2.35]));

    const result = await scoreContinuations(provider(), echoRoute, {
      prefix: PREFIX,
      options: [
        { optionId: 'A', text: 'A) Phishing' },
        { optionId: 'B', text: 'B) Invoice' },
      ],
    });

    expect(result.inputTokens).toBe(9);
  });
});

describe('scoreContinuations: refusing a surface that cannot really score', () => {
  beforeEach(() => axios.mockReset());

  it('refuses a response with no logprobs, naming the provider', async () => {
    // An engine can accept a completions request, ignore `echo`, and
    // answer 200 with an ordinary completion. Treating that as a score is
    // how a sampled answer gets reported as a distribution.
    axios.mockResolvedValue({ data: { choices: [{ text: 'B' }] } });

    await expect(
      scoreContinuations(provider(), echoRoute, {
        prefix: PREFIX,
        options: [{ optionId: 'A', text: 'A) Phishing' }],
      }),
    ).rejects.toThrow(ScoringCallError);

    await expect(
      scoreContinuations(provider(), echoRoute, {
        prefix: PREFIX,
        options: [{ optionId: 'A', text: 'A) Phishing' }],
      }),
    ).rejects.toThrow(/custom/);
  });

  it('refuses logprobs that arrive without offsets rather than guessing the boundary', async () => {
    axios.mockResolvedValue({
      data: { choices: [{ logprobs: { token_logprobs: [null, -0.5, -0.21] } }] },
    });

    await expect(
      scoreContinuations(provider(), echoRoute, {
        prefix: PREFIX,
        options: [{ optionId: 'A', text: 'A) Phishing' }],
      }),
    ).rejects.toThrow(/offsets/);
  });

  it('refuses an unscored token in the option tail', async () => {
    const response = echoed('A) Phishing', [-0.21, -3.1]);
    response.data.choices[0].logprobs.token_logprobs[4] = null as any;
    axios.mockResolvedValue(response);

    await expect(
      scoreContinuations(provider(), echoRoute, {
        prefix: PREFIX,
        options: [{ optionId: 'A', text: 'A) Phishing' }],
      }),
    ).rejects.toThrow(/unscored token/);
  });
});

describe('scoreContinuations: tgi_decoder_input_details', () => {
  beforeEach(() => axios.mockReset());

  const prefillRoute: ResolvedScoringRoute = {
    protocol: 'tgi_decoder_input_details',
    url: 'https://engine.example/generate',
    vendorModelId: 'qwen3-8b',
  };

  it('asks for prefill details and reads the option tail back', async () => {
    axios.mockResolvedValue({
      data: {
        details: {
          prefill: [
            { id: 1, text: 'Classify', logprob: null },
            { id: 2, text: ' the mail.', logprob: -0.5 },
            { id: 3, text: '\nAnswer: ', logprob: -0.5 },
            { id: 4, text: 'B', logprob: -2.35 },
            { id: 5, text: ')', logprob: -0.12 },
          ],
        },
      },
    });

    const result = await scoreContinuations(provider(), prefillRoute, {
      prefix: PREFIX,
      options: [{ optionId: 'B', text: 'B)' }],
    });

    expect(axios.mock.calls[0][0].data.parameters).toMatchObject({
      decoder_input_details: true,
      max_new_tokens: 1,
    });
    expect(result.scored).toEqual([{ optionId: 'B', tokenLogprobs: [-2.35, -0.12] }]);
  });
});
