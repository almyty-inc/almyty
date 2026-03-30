import { Injectable, Logger, NotFoundException, BadRequestException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { AgentInterface, InterfaceType, InterfaceStatus } from '../../entities/interface.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AuditAction, AuditResource } from '../../entities/audit-log.entity';

@Injectable()
export class InterfacesService {
  private readonly logger = new Logger(InterfacesService.name);

  constructor(
    @InjectRepository(AgentInterface)
    private readonly interfaceRepository: Repository<AgentInterface>,
    private readonly auditLogService: AuditLogService,
  ) {}

  async create(
    organizationId: string,
    data: {
      agentId: string;
      type: InterfaceType;
      name: string;
      configuration?: Record<string, any>;
      metadata?: Record<string, any>;
    },
  ): Promise<AgentInterface> {
    const iface = this.interfaceRepository.create({
      organizationId,
      agentId: data.agentId,
      type: data.type,
      name: data.name,
      status: InterfaceStatus.INACTIVE,
      configuration: data.configuration || {},
      metadata: data.metadata || null,
    });
    const saved = await this.interfaceRepository.save(iface);

    // Audit log (fire-and-forget)
    this.auditLogService.log({ organizationId, action: AuditAction.INTERFACE_DEPLOY, resourceType: AuditResource.INTERFACE, resourceId: saved.id, resourceName: saved.name, details: { type: saved.type, agentId: data.agentId } });

    return saved;
  }

  async findAll(organizationId: string, agentId?: string) {
    const where: any = { organizationId };
    if (agentId) where.agentId = agentId;
    return this.interfaceRepository.find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  async findById(id: string, organizationId: string): Promise<AgentInterface> {
    const iface = await this.interfaceRepository.findOne({ where: { id, organizationId } });
    if (!iface) throw new NotFoundException('Interface not found');
    return iface;
  }

  async update(id: string, organizationId: string, data: Partial<{
    name: string;
    status: InterfaceStatus;
    configuration: Record<string, any>;
    metadata: Record<string, any>;
  }>): Promise<AgentInterface> {
    const iface = await this.findById(id, organizationId);
    Object.assign(iface, data);
    return this.interfaceRepository.save(iface);
  }

  async remove(id: string, organizationId: string): Promise<void> {
    const iface = await this.findById(id, organizationId);
    await this.interfaceRepository.remove(iface);

    // Audit log (fire-and-forget)
    this.auditLogService.logDelete(organizationId, undefined, AuditResource.INTERFACE, id, iface.name);
  }

  async activate(id: string, organizationId: string): Promise<AgentInterface> {
    return this.update(id, organizationId, { status: InterfaceStatus.ACTIVE });
  }

  async deactivate(id: string, organizationId: string): Promise<AgentInterface> {
    return this.update(id, organizationId, { status: InterfaceStatus.INACTIVE });
  }

  async incrementMessages(id: string): Promise<void> {
    await this.interfaceRepository
      .createQueryBuilder()
      .update(AgentInterface)
      .set({
        totalMessages: () => '"totalMessages" + 1',
        lastMessageAt: new Date(),
      })
      .where('id = :id', { id })
      .execute();
  }

  async findByAgentId(agentId: string): Promise<AgentInterface[]> {
    return this.interfaceRepository.find({ where: { agentId }, order: { createdAt: 'DESC' } });
  }
}
