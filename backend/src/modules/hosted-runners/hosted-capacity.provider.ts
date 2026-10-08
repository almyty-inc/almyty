import { HostedRunnerSettingsService } from './hosted-runner-settings';

/**
 * How much hosted capacity an organization has: how many hosted runners
 * may run at once, how many persistent workspaces it may keep, and which
 * resource classes it may use (null: any configured class).
 */
export interface HostedCapacity {
  maxConcurrentRunners: number;
  maxWorkspaces: number;
  resourceClasses: string[] | null;
}

/**
 * The seam plan capacity plugs into. The Apache build answers from the
 * hosted runner settings (`capacity`), the same for every organization;
 * the billing module in `ee` replaces it with per-plan numbers (phase 3),
 * the way OrgLicenseResolver is filled. Numbers live in data either way.
 */
export interface HostedCapacityProvider {
  capacityFor(organizationId: string): Promise<HostedCapacity>;
}

export const HOSTED_CAPACITY_PROVIDER = Symbol('HOSTED_CAPACITY_PROVIDER');

/** The capacity the settings give every organization. */
export class SettingsCapacityProvider implements HostedCapacityProvider {
  constructor(private readonly settings: HostedRunnerSettingsService) {}

  async capacityFor(_organizationId: string): Promise<HostedCapacity> {
    const { maxConcurrentRunners, maxWorkspaces, resourceClasses } = this.settings.current.capacity;
    return { maxConcurrentRunners, maxWorkspaces, resourceClasses: resourceClasses ?? null };
  }
}

/** Why a wake or a new workspace was refused. */
export class CapacityExhaustedError extends Error {
  readonly code = 'CAPACITY_EXHAUSTED';
  constructor(message: string) {
    super(message);
    this.name = 'CapacityExhaustedError';
  }
}
