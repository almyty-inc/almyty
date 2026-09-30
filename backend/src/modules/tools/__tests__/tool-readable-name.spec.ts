import { readableToolName } from '../tool-readable-name';

/** The tool's name in an approval request's sentence is the one the dashboard shows. */
describe('readableToolName', () => {
  it("reads the operation's summary when the spec has one, without its full stop", () => {
    expect(readableToolName({ name: 'northwind_orders_create_refund', operation: { name: 'Issue a refund for an order.' } })).toBe(
      'Issue a refund for an order',
    );
  });

  it('otherwise puts the operation part of the machine name in words', () => {
    expect(readableToolName({ name: 'northwind_orders_create_refund', api: { name: 'Northwind Orders' } })).toBe('Create refund');
    expect(readableToolName({ name: 'issue_refund' })).toBe('Issue refund');
  });

  it('keeps a name people already wrote', () => {
    expect(readableToolName({ name: 'Refund an order' })).toBe('Refund an order');
    expect(readableToolName({ name: 'x', operation: { name: 'GET /refunds/{id}' } })).toBe('x');
  });
});
