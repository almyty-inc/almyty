import { Module } from '@nestjs/common';

import {
  ComplianceController,
  ChargebackController,
  ByoKmsController,
} from './ee-stubs.controllers';

/**
 * EE P5 scaffolds that are gated + surfaced but not yet implemented:
 *   - compliance_pack (T5.3) — wraps pii-filter/security-scanner as policy
 *   - chargeback     (T5.4) — extends P2 spend aggregation
 *   - byo_kms        (T5.5) — customer-managed KMS; needs live AWS creds
 *
 * Each controller enforces its entitlement (402 without a license) and
 * returns 501 to a licensed caller until the feature lands.
 */
@Module({
  controllers: [ComplianceController, ChargebackController, ByoKmsController],
})
export class EeStubsModule {}
