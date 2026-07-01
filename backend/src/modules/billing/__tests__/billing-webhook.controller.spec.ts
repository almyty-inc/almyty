import { BadRequestException } from '@nestjs/common';
import { BillingWebhookController } from '../billing-webhook.controller';

describe('BillingWebhookController', () => {
  let controller: BillingWebhookController;
  let billingService: any;
  let stripeService: any;

  beforeEach(() => {
    billingService = {
      handleWebhookEvent: jest.fn(async () => ({ handled: true, deduped: false, ignored: false })),
    };
    stripeService = { constructEvent: jest.fn() };
    controller = new BillingWebhookController(billingService, stripeService);
  });

  it('rejects a missing body or signature with 400', async () => {
    await expect(
      controller.handleWebhook({ rawBody: undefined } as any, 'sig'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      controller.handleWebhook({ rawBody: Buffer.from('{}') } as any, undefined as any),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(billingService.handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('rejects an invalid signature with 400 and never processes the event', async () => {
    stripeService.constructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature');
    });

    await expect(
      controller.handleWebhook({ rawBody: Buffer.from('{"id":"evt"}') } as any, 'bad-sig'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(billingService.handleWebhookEvent).not.toHaveBeenCalled();
  });

  it('verifies + dispatches a well-signed event', async () => {
    const evt = { id: 'evt_1', type: 'customer.subscription.updated' };
    stripeService.constructEvent.mockReturnValue(evt);

    const res = await controller.handleWebhook(
      { rawBody: Buffer.from('{"id":"evt_1"}') } as any,
      'good-sig',
    );

    expect(stripeService.constructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      'good-sig',
    );
    expect(billingService.handleWebhookEvent).toHaveBeenCalledWith(evt);
    expect(res).toEqual({ received: true, handled: true, deduped: false, ignored: false });
  });
});
