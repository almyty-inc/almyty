import { AgentAppsService } from '../agent-apps.service';
import { DistributionStatus, DistributionTarget } from '../../../entities/agent-app-distribution.entity';
import {
  ClauseModel,
  ExecutedQuery,
  RecordingQueryBuilder,
  clause,
  matchingRows,
} from '../../gateways/__tests__/recording-query-builder';

/**
 * Where an agent is in front of people: the read-only list on the agent's
 * Interfaces tab. The apps table is evaluated against the clauses the
 * query really ran, so the organization or agent predicate cannot go
 * missing with the suite green.
 */
const APP_CLAUSES: ClauseModel = {
  'app.organizationId = :organizationId': (row, p) => row.organizationId === p.organizationId,
  ':agentId = ANY(app.agentIds)': (row, p) => (row.agentIds ?? []).includes(p.agentId),
};

const dist = (target: DistributionTarget, configuration: Record<string, any> = {}, status = DistributionStatus.LIVE) => ({
  target,
  status,
  configuration,
});

describe('AgentAppsService.usedBy', () => {
  const apps = [
    {
      organizationId: 'org-1',
      slug: 'support',
      name: 'support',
      branding: { appName: 'Acme support' },
      agentIds: ['triage', 'billing'],
      distributions: [
        dist(DistributionTarget.WEB),
        dist(DistributionTarget.SLACK, { agentId: 'billing' }),
        dist(DistributionTarget.TELEGRAM, {}, DistributionStatus.DRAFT),
      ],
    },
    {
      organizationId: 'org-1',
      slug: 'billing-desk',
      name: 'Billing desk',
      branding: null,
      agentIds: ['other', 'billing'],
      distributions: [dist(DistributionTarget.WEB)],
    },
    { organizationId: 'org-2', slug: 'theirs', name: 'Theirs', agentIds: ['triage'], distributions: [dist(DistributionTarget.WEB)] },
    { organizationId: 'org-1', slug: 'unrelated', name: 'Unrelated', agentIds: ['other'], distributions: [dist(DistributionTarget.WEB)] },
  ];

  let qb: RecordingQueryBuilder;
  const service = Object.create(AgentAppsService.prototype) as AgentAppsService;
  (service as any).appRepository = {
    createQueryBuilder: (alias: string) =>
      (qb = new RecordingQueryBuilder(alias, {
        getMany: (query: ExecutedQuery) => matchingRows(query, apps, APP_CLAUSES),
      })),
  };

  it('lists the places where the agent answers, by default or by name', async () => {
    await expect(service.usedBy('org-1', 'triage')).resolves.toEqual([
      {
        slug: 'support',
        name: 'Acme support',
        places: [
          { target: 'telegram', status: 'draft' },
          { target: 'web', status: 'live' },
        ],
      },
    ]);
    expect(clause(qb.executed[0], 'app.organizationId = :organizationId')?.params).toEqual({ organizationId: 'org-1' });
  });

  it('keeps an app the agent is part of even where another agent answers everywhere', async () => {
    await expect(service.usedBy('org-1', 'billing')).resolves.toEqual([
      { slug: 'support', name: 'Acme support', places: [{ target: 'slack', status: 'live' }] },
      { slug: 'billing-desk', name: 'Billing desk', places: [] },
    ]);
  });

  it('never lists another organization', async () => {
    await expect(service.usedBy('org-2', 'billing')).resolves.toEqual([]);
  });
});
