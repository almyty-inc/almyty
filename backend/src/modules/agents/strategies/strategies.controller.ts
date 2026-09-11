import { Controller, Get, HttpException, HttpStatus, Request, UseGuards } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';

import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { RolesGuard } from '../../auth/guards/roles.guard';
import { Roles } from '../../auth/decorators/roles.decorator';
import { Strategy } from '../../../entities/strategy.entity';
import { STRATEGY_SEEDS } from './strategy-seeds';
import { describeStrategy } from './strategy-compiler';

/**
 * The strategies an organization can pick from: the built-in shapes plus
 * anything it has defined itself.
 *
 * Described rather than dumped. A picker needs the slots a shape requires
 * and roughly what it costs; the step graph is the compiler's business.
 * See docs/design/layers.md, L5.
 */
@ApiTags('Strategies')
@ApiBearerAuth()
@Controller('strategies')
@UseGuards(JwtAuthGuard, RolesGuard)
export class StrategiesController {
  constructor(@InjectRepository(Strategy) private readonly strategies: Repository<Strategy>) {}

  private orgId(req: any): string {
    const organizationId = req.user?.currentOrganizationId;
    if (!organizationId) {
      throw new HttpException({ success: false, message: 'No organization found for user', error: 'NO_ORGANIZATION' }, HttpStatus.BAD_REQUEST);
    }
    return organizationId;
  }

  @Get()
  @Roles('member', 'admin', 'owner')
  @ApiOperation({ summary: 'Strategies this organization can use, with slots and cost bands' })
  async list(@Request() req: any) {
    const organizationId = this.orgId(req);
    const stored = await this.strategies.find({ where: [{ organizationId }, { organizationId: IsNull() }] });

    // The seeds are the source of truth for built-ins, so a fresh install
    // that has never run the seeder still lists them. An organization's
    // own row with the same key wins, which is how you customise one.
    const byKey = new Map<string, { key: string; displayName: string; description: string; roleSlots: string[]; shape: Strategy['shape']; builtIn: boolean; experimental?: boolean }>();
    for (const seed of STRATEGY_SEEDS) byKey.set(seed.key, { ...seed, builtIn: true });
    for (const row of stored) {
      if (row.organizationId === organizationId || !byKey.has(row.key)) {
        byKey.set(row.key, {
          key: row.key,
          displayName: row.displayName,
          description: row.description,
          roleSlots: row.roleSlots,
          shape: row.shape,
          builtIn: row.organizationId === null,
          experimental: row.experimental,
        });
      }
    }

    const data = [...byKey.values()].map((s) => ({
      ...describeStrategy(s),
      description: s.description,
      builtIn: s.builtIn,
    }));
    return { success: true, data };
  }
}
