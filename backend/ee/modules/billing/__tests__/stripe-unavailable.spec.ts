import { ServiceUnavailableException } from '@nestjs/common';
import Stripe from 'stripe';

import { StripeService } from '../stripe.service';

/**
 * Staging's Stripe test key expired and Settings > Billing answered
 * GET /billing/:org/invoices with an unhandled 500. Stripe refusing our key
 * (or being down) is reported as a 503 that says so, without the key.
 */
describe('StripeService: Stripe unavailable', () => {
  function serviceWith(list: jest.Mock) {
    const service = new StripeService({ get: () => 'sk_test_x' } as any);
    (service as any).client = { invoices: { list } };
    return service;
  }

  it('turns an expired or refused key into a 503 that does not echo the key', async () => {
    const expired = new Stripe.errors.StripeAuthenticationError({
      message: 'Expired API Key provided: sk_test_***eKig1k',
      type: 'invalid_request_error',
    } as any);
    const service = serviceWith(jest.fn().mockRejectedValue(expired));

    const failure = await service.listInvoices('cus_1').catch((e) => e);

    expect(failure).toBeInstanceOf(ServiceUnavailableException);
    expect(failure.message).toBe('The billing provider is unavailable right now. Try again later.');
    expect(failure.message).not.toContain('sk_test');
  });

  it('turns a connection failure into a 503', async () => {
    const down = new Stripe.errors.StripeConnectionError({ message: 'socket hang up' } as any);
    const service = serviceWith(jest.fn().mockRejectedValue(down));

    await expect(service.listInvoices('cus_1')).rejects.toBeInstanceOf(ServiceUnavailableException);
  });

  it('passes any other error through unchanged', async () => {
    const invalid = new Stripe.errors.StripeInvalidRequestError({ message: 'No such customer' } as any);
    const service = serviceWith(jest.fn().mockRejectedValue(invalid));

    await expect(service.listInvoices('cus_1')).rejects.toBe(invalid);
  });
});
