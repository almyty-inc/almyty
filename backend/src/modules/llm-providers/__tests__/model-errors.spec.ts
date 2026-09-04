import { ModelNotFoundError, isModelNotFoundError, isModelNotFoundResponse, vendorMessage } from '../model-errors';

describe('isModelNotFoundResponse', () => {
  it('recognises each vendor wording', () => {
    expect(isModelNotFoundResponse(404, { type: 'error', error: { type: 'not_found_error', message: 'model: claude-sonnet-4-20250514' } })).toBe(true);
    expect(isModelNotFoundResponse(404, { error: { code: 'model_not_found', message: 'The model `gpt-4-32k` does not exist' } })).toBe(true);
    expect(isModelNotFoundResponse(400, { error: { message: 'The model `gpt-4-32k` does not exist or you do not have access to it.' } })).toBe(true);
    expect(isModelNotFoundResponse(404, { error: { code: 404, message: 'models/gemini-1.0-pro is not found for API version v1beta' } })).toBe(true);
    expect(isModelNotFoundResponse(404, { message: 'Invalid model: mistral-tiny' })).toBe(true);
    expect(isModelNotFoundResponse(404, { error: "model 'llama2' not found" })).toBe(true);
  });

  it('does not fire on other 404s or on rate limits', () => {
    expect(isModelNotFoundResponse(404, { error: { type: 'not_found_error', message: 'Not Found' } })).toBe(false);
    expect(isModelNotFoundResponse(429, { error: { message: 'Rate limit exceeded for model gpt-4o' } })).toBe(false);
    expect(isModelNotFoundResponse(404, undefined)).toBe(false);
    expect(isModelNotFoundResponse(500, { error: { message: 'model overloaded' } })).toBe(false);
  });
});

describe('ModelNotFoundError', () => {
  it('carries a stable code, the model, and the vendor wording', () => {
    const err = new ModelNotFoundError('claude-sonnet-4-20250514', 'p1', 'anthropic', 'model: claude-sonnet-4-20250514');
    expect(err.code).toBe('MODEL_NOT_FOUND');
    expect(err.status).toBe(404);
    expect(err.message).toMatch(/claude-sonnet-4-20250514/);
    expect(err.message).toMatch(/pick a current model/);
    expect(isModelNotFoundError(err)).toBe(true);
  });

  it('is found through a wrapping error chain', () => {
    const inner = new ModelNotFoundError('x', 'p', 'openai');
    const wrapped = Object.assign(new Error('LLM call failed: ' + inner.message), { cause: inner });
    expect(isModelNotFoundError(wrapped)).toBe(true);
    expect(isModelNotFoundError(new Error('boom'))).toBe(false);
    expect(isModelNotFoundError(Object.assign(new Error('x'), { code: 'MODEL_NOT_FOUND' }))).toBe(true);
  });

  it('extracts the vendor message from the common body shapes', () => {
    expect(vendorMessage({ error: { message: 'a' } })).toBe('a');
    expect(vendorMessage({ message: 'b' })).toBe('b');
    expect(vendorMessage({ error: 'c' })).toBe('c');
    expect(vendorMessage('plain')).toBe('plain');
    expect(vendorMessage(undefined)).toBeUndefined();
  });
});
