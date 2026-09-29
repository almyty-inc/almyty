import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { createHash } from 'crypto';

import { AgentApp } from '../../entities/agent-app.entity';
import { DistributionTarget, isChannelTarget } from '../../entities/agent-app-distribution.entity';
import { AuditAction, AuditLog, AuditResource } from '../../entities/audit-log.entity';
import { OrganizationRole } from '../../entities/user-organization.entity';
import { AuditLogOptions, AuditLogService } from '../audit-log/audit-log.service';
import {
  AppVisitorDataService,
  VisitorDataSummary,
  VisitorErasure,
  VisitorFootprint,
  VisitorPlace,
  VisitorPlaceKind,
} from '../gateways/app-visitor-data.service';
import { AgentAppsService } from './agent-apps.service';

/** Who is answering the request: their id and their role in the app's organization. */
export interface DataRequestCaller {
  userId: string;
  organizationId: string;
  role: OrganizationRole | string | null | undefined;
}

/** A person, as the operator knows them: the place they used and what identifies them there. */
export interface DataRequestSubject {
  place: string;
  id: string;
}

/** The kind of place each target is, for the targets a person can talk to. */
export function visitorPlaceKind(target: string): VisitorPlaceKind | null {
  if (target === DistributionTarget.WEB) return 'web';
  if (target === DistributionTarget.WIDGET) return 'widget';
  if (target === DistributionTarget.A2A) return 'a2a';
  if (isChannelTarget(target)) return 'channel';
  return null;
}

/**
 * A reference to the person for the audit log that is not the person:
 * the same identifier on the same place always gives the same reference,
 * so an auditor holding the identifier can find the entries, and the log
 * itself never holds a phone number or an email address.
 */
export function subjectRef(organizationId: string, place: string, id: string): string {
  const normalized = id.trim().toLowerCase();
  return `sha256:${createHash('sha256').update(`${organizationId}:${place}:${normalized}`).digest('hex').slice(0, 24)}`;
}

/**
 * An owner or admin answering a data request for one person.
 *
 * People on the web chat and the widget can download and delete their own
 * data. People who reached the app through a messaging channel or A2A
 * cannot: there is no page to put a button on. Their request goes to the
 * operator, who looks the person up here by what they know about them on
 * that place, and exports or erases it. Same scope as the self-service
 * paths, because it is the same code (AppVisitorDataService).
 *
 * Owners and admins only, and a member gets the same 404 as another
 * organization: whether a person has talked to the app is itself personal
 * data, and a member cannot manage the app in any case. Every export and
 * erasure is written to the audit log with counts and a hashed reference
 * to the person, never the identifier or any content.
 */
@Injectable()
export class AppVisitorRequestsService {
  constructor(
    private readonly apps: AgentAppsService,
    private readonly visitorData: AppVisitorDataService,
    // Required: an export or erasure that cannot be recorded does not happen.
    private readonly audit: AuditLogService,
  ) {}

  /** What is held for the person, in counts and dates. */
  async lookup(caller: DataRequestCaller, slug: string, subject: DataRequestSubject): Promise<VisitorDataSummary> {
    const { footprint } = await this.resolve(caller, slug, subject);
    return this.visitorData.summarize(footprint);
  }

  /**
   * Everything held for the person, for them to keep. Recorded before it
   * is handed over: if the audit row cannot be written, nothing is exported.
   */
  async export(caller: DataRequestCaller, slug: string, subject: DataRequestSubject): Promise<Record<string, unknown>> {
    const { app, kind, footprint } = await this.resolve(caller, slug, subject);
    const summary = await this.visitorData.summarize(footprint);
    const data = await this.visitorData.export(footprint);
    const recorded = await this.audit.log(
      this.entry(AuditAction.VISITOR_DATA_EXPORT, caller, app, subject, kind, {
        conversations: summary.conversations,
        messages: summary.messages,
        memories: summary.memories,
        storedReplies: summary.storedReplies,
        files: summary.files,
        runs: summary.runs,
      }),
    );
    if (!recorded) {
      throw new ServiceUnavailableException('This request could not be recorded, so nothing was exported. Try again.');
    }
    return {
      app: app.branding?.appName || app.name,
      place: subject.place,
      ...data,
    };
  }

  /**
   * Remove everything held for the person in this app. The audit row is
   * written in the erasure's own transaction: both happen, or neither.
   */
  async erase(caller: DataRequestCaller, slug: string, subject: DataRequestSubject): Promise<VisitorErasure> {
    const { app, kind, footprint } = await this.resolve(caller, slug, subject);
    const written: AuditLog[] = [];
    const removed = await this.visitorData.erase(footprint, async (tx, counts) => {
      written.push(
        await this.audit.logInTransaction(tx, this.entry(AuditAction.VISITOR_DATA_ERASE, caller, app, subject, kind, { ...counts })),
      );
    });
    this.audit.publishCommitted(written);
    return removed;
  }

  private async resolve(
    caller: DataRequestCaller,
    slug: string,
    subject: DataRequestSubject,
  ): Promise<{ app: AgentApp; kind: VisitorPlaceKind; footprint: VisitorFootprint }> {
    if (caller.role !== OrganizationRole.OWNER && caller.role !== OrganizationRole.ADMIN) {
      throw new NotFoundException('App not found');
    }
    const app = await this.apps.findOne(caller.organizationId, slug);
    const place = String(subject?.place ?? '').trim();
    const id = String(subject?.id ?? '').trim();
    const kind = visitorPlaceKind(place);
    if (!kind) {
      throw new BadRequestException(
        'Look people up on a place that talks to them: the web chat, the website widget, a messaging channel or A2A.',
      );
    }
    if (!id) throw new BadRequestException('Say who to look up.');
    const distribution = (app.distributions ?? []).find((d) => d.target === place && d.gatewayId);
    if (!distribution?.gatewayId) throw new NotFoundException('This app is not on that place.');
    const gateway: VisitorPlace = { id: distribution.gatewayId, organizationId: app.organizationId };

    let footprint: VisitorFootprint;
    switch (kind) {
      case 'web':
        footprint = await this.visitorData.forWebVisitors(gateway, await this.visitorData.findWebVisitors(gateway, id));
        break;
      case 'widget':
        footprint = await this.visitorData.forWidgetThread(gateway, id);
        break;
      case 'a2a':
        footprint = await this.visitorData.forA2ACaller(gateway, id);
        break;
      default:
        footprint = await this.visitorData.forChannelSender(gateway, place, id);
    }
    return { app, kind, footprint };
  }

  private entry(
    action: AuditAction,
    caller: DataRequestCaller,
    app: AgentApp,
    subject: DataRequestSubject,
    kind: VisitorPlaceKind,
    counts: Record<string, number>,
  ): AuditLogOptions {
    return {
      organizationId: app.organizationId,
      userId: caller.userId,
      action,
      resourceType: AuditResource.APP,
      resourceId: app.id,
      resourceName: app.name,
      details: {
        request: action === AuditAction.VISITOR_DATA_ERASE ? 'erase' : 'export',
        place: subject.place,
        kind,
        subject: subjectRef(app.organizationId, subject.place, subject.id),
        counts,
      },
    };
  }
}
