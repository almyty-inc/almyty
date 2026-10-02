import { SENTRY_DATA_COLLECTION, sentryInitOptions } from './sentry-options';

describe('sentryInitOptions', () => {
  it('is null without a DSN', () => {
    expect(sentryInitOptions({})).toBeNull();
  });

  it('turns off every category @sentry/node 11 collects by default', () => {
    const options = sentryInitOptions({ SENTRY_DSN: 'https://public@sentry.invalid/1' });
    expect(options?.dataCollection).toEqual({
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      graphQL: { document: false, variables: false },
      genAI: { inputs: false, outputs: false },
      databaseQueryData: false,
      queues: false,
      stackFrameVariables: false,
    });
  });

  // Loading @sentry/node pulls in its whole OpenTelemetry stack, which is
  // slow on a busy machine; the assertion itself is instant.
  it('is what the initialized client resolves its collection rules to', async () => {
    const Sentry = require('@sentry/node');
    const options = sentryInitOptions({ SENTRY_DSN: 'https://public@sentry.invalid/1' })!;
    Sentry.init({ ...options, defaultIntegrations: false });
    try {
      const client = Sentry.getClient();
      expect(client.getOptions().dataCollection).toEqual(SENTRY_DATA_COLLECTION);
      // The SDK's own resolution, defaults applied: nothing left on.
      const resolved = client.getDataCollectionOptions();
      expect(resolved).toMatchObject({
        userInfo: false,
        cookies: false,
        httpHeaders: { request: false, response: false },
        httpBodies: [],
        urlQueryParams: false,
        graphQL: { document: false, variables: false },
        genAI: { inputs: false, outputs: false },
        databaseQueryData: false,
        queues: false,
        stackFrameVariables: false,
      });
    } finally {
      await Sentry.close(0);
    }
  }, 120_000);
});
