import { CanActivate, ExecutionContext, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { LlmProvider } from '../../entities/llm-provider.entity';
import { Conversation } from '../../entities/conversation.entity';
import { AccessPolicyService } from '../../common/authorization/access-policy.service';
import { canRead } from '../../common/authorization/read-rule';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * An LLM provider the caller may not read does not exist, on every
 * dashboard route that names one: `:providerId` directly, or `:sessionId`
 * through the session's provider. Sits after JwtAuthGuard on the provider
 * controllers, so usage, models, chat, test and sessions all answer like
 * a missing provider rather than each having to remember to.
 *
 * The rule is the read rule (read-rule.ts): another member's private
 * provider is refused to everyone, org admins included; a team provider to
 * anyone outside the team who is not an org owner or admin.
 */
@Injectable()
export class PrivateProviderGuard implements CanActivate {
  constructor(
    @InjectRepository(LlmProvider)
    private readonly providers: Repository<LlmProvider>,
    @InjectRepository(Conversation)
    private readonly conversations: Repository<Conversation>,
    private readonly accessPolicy: AccessPolicyService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest();
    let providerId: unknown = req?.params?.providerId;
    const sessionId: unknown = req?.params?.sessionId;
    if (typeof sessionId === 'string' && UUID.test(sessionId)) {
      const session = await this.conversations.findOne({
        where: { id: sessionId },
        select: { id: true, providerId: true },
      });
      providerId = session?.providerId ?? providerId;
    }
    if (typeof providerId !== 'string' || !UUID.test(providerId)) return true;

    const row = await this.providers.findOne({
      where: { id: providerId },
      select: { id: true, organizationId: true, visibility: true, ownerUserId: true, teamId: true },
    });
    const userId: string | undefined = req?.user?.id;
    if (row && (!userId || !(await canRead(this.accessPolicy, { id: userId }, row)))) {
      // The body the controllers send for a provider that does not exist.
      throw new NotFoundException({ success: false, message: 'Provider not found', error: 'PROVIDER_NOT_FOUND' });
    }
    return true;
  }
}