import {
  BadRequestException,
  Controller,
  Headers,
  HttpCode,
  Logger,
  Post,
  Req,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { BillingService } from './billing.service';
import { StripeService } from './stripe.service';

/**
 * Public Stripe webhook receiver. Deliberately unauthenticated — authenticity
 * comes from the Stripe signature, verified against STRIPE_WEBHOOK_SECRET over
 * the RAW request body (JSON re-serialization would break the signature, so the
 * app is bootstrapped with `rawBody: true`). Kept on its own controller so the
 * JWT/roles guards on the admin billing controller never touch this route.
 */
@Controller('billing')
@ApiExcludeController()
export class BillingWebhookController {
  private readonly logger = new Logger(BillingWebhookController.name);

  constructor(
    private readonly billingService: BillingService,
    private readonly stripeService: StripeService,
  ) {}

  @Post('webhook')
  @HttpCode(200)
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Headers('stripe-signature') signature: string,
  ) {
    const raw = req.rawBody;
    if (!raw || !signature) {
      throw new BadRequestException('Missing webhook body or signature');
    }

    let event;
    try {
      event = this.stripeService.constructEvent(raw, signature);
    } catch (err) {
      this.logger.warn(`Stripe webhook signature verification failed: ${err.message}`);
      throw new BadRequestException('Invalid webhook signature');
    }

    const result = await this.billingService.handleWebhookEvent(event);
    return { received: true, ...result };
  }
}
