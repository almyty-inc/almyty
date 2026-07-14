import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ReferralCode } from '../../entities/referral-code.entity';
import { Referral } from '../../entities/referral.entity';
import { Organization } from '../../entities/organization.entity';
import { Gateway } from '../../entities/gateway.entity';
import { AgentRun } from '../../entities/agent-run.entity';
import { User } from '../../entities/user.entity';
import { ReferralsService } from './referrals.service';
import { ReferralQualificationService } from './referral-qualification.service';
import { ReferralsController } from './referrals.controller';

/**
 * Invite/referral program (core, OSS). Rewards are free plan-time — the
 * platform has no usage-credit ledger, so a reward is always an extension
 * of `organization.planExpiresAt`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([ReferralCode, Referral, Organization, Gateway, AgentRun, User]),
  ],
  providers: [ReferralsService, ReferralQualificationService],
  controllers: [ReferralsController],
  exports: [ReferralsService],
})
export class ReferralsModule {}
