import { Module } from '@nestjs/common';

import { ByoKmsController } from './ee-stubs.controllers';

/**
 * Remaining EE P5 scaffold that is gated + surfaced but not yet
 * implemented:
 *   - byo_kms (T5.5, issue #239) — customer-managed KMS; needs live AWS creds
 *
 * compliance_pack (T5.3 → modules/compliance) and chargeback
 * (T5.4 → modules/chargeback) have been implemented and moved out.
 *
 * The controller enforces its entitlement (402 without a license) and
 * returns 501 to a licensed caller until the feature lands.
 */
@Module({
  controllers: [ByoKmsController],
})
export class EeStubsModule {}