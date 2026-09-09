import { BadRequestException, ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { AuditAction, AuditResource } from '../../entities/audit-log.entity';
import { AuditLogService } from '../audit-log/audit-log.service';
import { AdapterRegistry } from '../model-deployments/adapters/adapter.registry';
import { BUILTIN_CONNECTORS, connectorFromAdapter } from './connector-catalog';
import { validateConnectorDefinition } from './connector-schema';
import { CustomConnector } from './connector.entity';
import { ConnectorDefinition, ConnectorKind } from './connector.types';

/**
 * The connector catalog an org sees: built-ins (data), connectors derived
 * from the deployment adapter registry at runtime, and the org's own
 * custom connectors. Custom keys may not shadow built-ins.
 */
@Injectable()
export class ConnectorCatalogService {
  constructor(
    @InjectRepository(CustomConnector) private readonly customRepo: Repository<CustomConnector>,
    private readonly auditLog: AuditLogService,
    @Optional() private readonly adapters?: AdapterRegistry,
  ) {}

  /** Built-in plus adapter-derived connectors; no org data. */
  builtIn(): ConnectorDefinition[] {
    const out = [...BUILTIN_CONNECTORS];
    const covered = new Set(out.map((c) => c.adapterKey).filter(Boolean));
    for (const adapter of this.adapters?.describe() ?? []) {
      if (covered.has(adapter.key)) continue;
      const derived = connectorFromAdapter(adapter);
      if (derived) out.push(derived);
    }
    return out;
  }

  async list(organizationId: string, kind?: ConnectorKind): Promise<ConnectorDefinition[]> {
    const custom = await this.customRepo.find({ where: { organizationId }, order: { createdAt: 'ASC' } });
    const all = [...this.builtIn(), ...custom.map((c) => ({ ...c.definition, key: c.key, kind: c.kind, displayName: c.displayName, organizationId }))];
    return kind ? all.filter((c) => c.kind === kind) : all;
  }

  async find(organizationId: string, key: string): Promise<ConnectorDefinition | null> {
    const builtIn = this.builtIn().find((c) => c.key === key);
    if (builtIn) return builtIn;
    const custom = await this.customRepo.findOne({ where: { organizationId, key } });
    return custom ? { ...custom.definition, key: custom.key, kind: custom.kind, displayName: custom.displayName, organizationId } : null;
  }

  async require(organizationId: string, key: string): Promise<ConnectorDefinition> {
    const found = await this.find(organizationId, key);
    if (!found) throw new NotFoundException({ code: 'CONNECTOR_UNKNOWN', message: `unknown connector: ${key}` });
    return found;
  }

  async createCustom(organizationId: string, userId: string, definition: ConnectorDefinition): Promise<ConnectorDefinition> {
    const errors = validateConnectorDefinition(definition);
    if (errors.length) throw new BadRequestException({ code: 'CONNECTOR_INVALID', message: errors.join('; '), errors });
    if (this.builtIn().some((c) => c.key === definition.key)) {
      throw new ConflictException({ code: 'CONNECTOR_KEY_TAKEN', message: `${definition.key} is a built-in connector` });
    }
    if (await this.customRepo.findOne({ where: { organizationId, key: definition.key } })) {
      throw new ConflictException({ code: 'CONNECTOR_KEY_TAKEN', message: `${definition.key} already exists in this organization` });
    }
    const { organizationId: _ignored, ...clean } = definition;
    const row = this.customRepo.create({
      organizationId,
      key: clean.key,
      kind: clean.kind,
      displayName: clean.displayName,
      definition: clean,
      createdBy: userId,
    });
    const saved = await this.customRepo.save(row);
    this.auditLog.log({
      organizationId, userId, action: AuditAction.CONNECTOR_CREATE, resourceType: AuditResource.CONNECTOR,
      resourceId: saved.id, resourceName: saved.key, details: { kind: saved.kind },
    });
    return { ...saved.definition, organizationId };
  }
}
