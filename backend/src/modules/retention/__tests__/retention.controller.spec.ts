import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';
import { RetentionController } from '../retention.controller';
import { UpdateRetentionPolicyDto } from '../dto/update-retention-policy.dto';
import { ROLES_KEY } from '../../auth/decorators/roles.decorator';

describe('RetentionController', () => {
  describe('access control', () => {
    it.each(['getRetentionPolicy', 'updateRetentionPolicy'] as const)(
      '%s is restricted to admin/owner',
      (handler) => {
        const roles = Reflect.getMetadata(
          ROLES_KEY,
          RetentionController.prototype[handler],
        );
        expect(roles).toEqual(['admin', 'owner']);
      },
    );

    it('the controller is guarded (JwtAuthGuard + RolesGuard)', () => {
      const guards = Reflect.getMetadata('__guards__', RetentionController);
      expect(guards).toHaveLength(2);
    });
  });

  describe('handlers', () => {
    let service: any;
    let controller: RetentionController;

    beforeEach(() => {
      service = {
        getPolicy: jest.fn().mockResolvedValue({ organizationId: 'org-1' }),
        upsertPolicy: jest.fn().mockResolvedValue({ organizationId: 'org-1', agentRunsDays: 30 }),
      };
      controller = new RetentionController(service);
    });

    it('GET returns the policy in the standard envelope', async () => {
      const result = await controller.getRetentionPolicy('org-1');
      expect(service.getPolicy).toHaveBeenCalledWith('org-1');
      expect(result).toEqual({
        success: true,
        data: { organizationId: 'org-1' },
        message: 'Retention policy retrieved successfully',
      });
    });

    it('PUT forwards the dto and acting user id', async () => {
      const dto = { agentRunsDays: 30 };
      const result = await controller.updateRetentionPolicy('org-1', dto as any, {
        user: { id: 'user-1' },
      });
      expect(service.upsertPolicy).toHaveBeenCalledWith('org-1', dto, 'user-1');
      expect(result.success).toBe(true);
    });
  });

  describe('UpdateRetentionPolicyDto validation', () => {
    const dayFields = [
      'agentRunsDays',
      'conversationsDays',
      'requestLogsDays',
      'usageMetricsDays',
      'auditLogDays',
    ] as const;

    async function errorsFor(payload: Record<string, unknown>) {
      const dto = plainToInstance(UpdateRetentionPolicyDto, payload);
      return validate(dto);
    }

    it('accepts an empty body', async () => {
      expect(await errorsFor({})).toHaveLength(0);
    });

    it.each(dayFields)('%s accepts null (keep forever)', async (field) => {
      expect(await errorsFor({ [field]: null })).toHaveLength(0);
    });

    it.each(dayFields)('%s accepts the 1..3650 range bounds', async (field) => {
      expect(await errorsFor({ [field]: 1 })).toHaveLength(0);
      expect(await errorsFor({ [field]: 3650 })).toHaveLength(0);
    });

    it.each(dayFields)('%s rejects 0 and negatives', async (field) => {
      expect(await errorsFor({ [field]: 0 })).not.toHaveLength(0);
      expect(await errorsFor({ [field]: -5 })).not.toHaveLength(0);
    });

    it.each(dayFields)('%s rejects values above 3650', async (field) => {
      expect(await errorsFor({ [field]: 3651 })).not.toHaveLength(0);
    });

    it.each(dayFields)('%s rejects non-integers', async (field) => {
      expect(await errorsFor({ [field]: 1.5 })).not.toHaveLength(0);
      expect(await errorsFor({ [field]: 'thirty' })).not.toHaveLength(0);
    });

    it('enabled must be a boolean', async () => {
      expect(await errorsFor({ enabled: true })).toHaveLength(0);
      expect(await errorsFor({ enabled: 'yes' })).not.toHaveLength(0);
    });
  });
});
