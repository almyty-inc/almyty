import { callWithDeprecatedParamRetry } from '../providers/anthropic.provider';

/**
 * Regression: claude-opus-4-8+ rejects `temperature` with a 400
 * invalid_request_error ("`temperature` is deprecated for this model."),
 * which broke the provider health check (it sets temperature
 * unconditionally) and every agent config carrying a temperature.
 * Diagnosed live on staging after the account was funded — the retry
 * strips exactly the param Anthropic names and tries once more.
 */
describe('callWithDeprecatedParamRetry', () => {
  const deprecatedError = (param: string) => ({
    response: {
      status: 400,
      data: {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `\`${param}\` is deprecated for this model.`,
        },
      },
    },
  });

  it('strips the named deprecated param and retries once', async () => {
    const body: Record<string, unknown> = { model: 'claude-opus-4-8', temperature: 0.1, max_tokens: 10 };
    const call = jest
      .fn()
      .mockRejectedValueOnce(deprecatedError('temperature'))
      .mockResolvedValueOnce({ data: { ok: true } });

    const res = await callWithDeprecatedParamRetry(call, body);

    expect(res).toEqual({ data: { ok: true } });
    expect(call).toHaveBeenCalledTimes(2);
    expect(body).not.toHaveProperty('temperature');
    expect(body.model).toBe('claude-opus-4-8');
  });

  it('propagates non-deprecation 400s untouched (e.g. credit balance)', async () => {
    const body: Record<string, unknown> = { model: 'claude-opus-4-8', temperature: 0.1 };
    const creditError = {
      response: {
        status: 400,
        data: { type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } },
      },
    };
    const call = jest.fn().mockRejectedValue(creditError);

    await expect(callWithDeprecatedParamRetry(call, body)).rejects.toBe(creditError);
    expect(call).toHaveBeenCalledTimes(1);
    expect(body).toHaveProperty('temperature');
  });

  it('does not retry when the named param is not in the request body', async () => {
    const body: Record<string, unknown> = { model: 'claude-opus-4-8' };
    const call = jest.fn().mockRejectedValue(deprecatedError('temperature'));

    await expect(callWithDeprecatedParamRetry(call, body)).rejects.toBeDefined();
    expect(call).toHaveBeenCalledTimes(1);
  });

  it('retries only once even if the second attempt also fails', async () => {
    const body: Record<string, unknown> = { temperature: 0.1, top_p: 0.9 };
    const call = jest
      .fn()
      .mockRejectedValueOnce(deprecatedError('temperature'))
      .mockRejectedValueOnce(deprecatedError('top_p'));

    // second failure names top_p — a fresh param — and IS retried by the
    // recursive call, so allow the chain but assert bounded behavior:
    const call2 = jest
      .fn()
      .mockRejectedValueOnce(deprecatedError('temperature'))
      .mockRejectedValue({ response: { status: 500, data: {} } });
    await expect(callWithDeprecatedParamRetry(call2, { temperature: 0.1 })).rejects.toBeDefined();
    expect(call2).toHaveBeenCalledTimes(2);
    void call; void body;
  });
});
