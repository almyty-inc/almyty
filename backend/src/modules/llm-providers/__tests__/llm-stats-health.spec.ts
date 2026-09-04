import { LlmStatsHelper } from '../llm-stats.helper';

/**
 * The providers page decides "failing right now" by comparing
 * lastErrorAt with lastSuccessAt, so a success must stamp the latter.
 */
describe('LlmStatsHelper.bumpProviderStats health stamps', () => {
  function helperWith(): { helper: LlmStatsHelper; set: jest.Mock } {
    const set = jest.fn().mockReturnThis();
    const qb: any = { update: jest.fn().mockReturnThis(), set, where: jest.fn().mockReturnThis(), execute: jest.fn().mockResolvedValue(undefined) };
    const providerRepo: any = { createQueryBuilder: jest.fn(() => qb) };
    const conversationRepo: any = {};
    return { helper: new LlmStatsHelper(conversationRepo, providerRepo), set };
  }

  it('stamps lastSuccessAt on a successful call', async () => {
    const { helper, set } = helperWith();
    await helper.bumpProviderStats('p1', { tokens: 10, cost: 0.001, success: true });
    expect(set.mock.calls[0][0].lastSuccessAt).toEqual(expect.any(Date));
  });

  it('leaves lastSuccessAt alone on a failed call', async () => {
    const { helper, set } = helperWith();
    await helper.bumpProviderStats('p1', { tokens: 0, cost: 0, success: false });
    expect(set.mock.calls[0][0]).not.toHaveProperty('lastSuccessAt');
  });
});
