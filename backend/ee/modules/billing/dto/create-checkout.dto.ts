import { IsIn, IsInt, IsOptional, IsString, IsUrl, Max, Min } from 'class-validator';
import { BILLING_INTERVALS, BillingInterval, PAID_PLANS } from '../billing.constants';

export class CreateCheckoutDto {
  @IsString()
  @IsIn(PAID_PLANS)
  plan: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  seats?: number;

  @IsOptional()
  @IsIn(BILLING_INTERVALS)
  interval?: BillingInterval;

  @IsOptional()
  @IsUrl({ require_tld: false })
  successUrl?: string;

  @IsOptional()
  @IsUrl({ require_tld: false })
  cancelUrl?: string;
}
