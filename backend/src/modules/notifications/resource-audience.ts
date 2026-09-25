import { OrganizationRole } from '../../entities/user-organization.entity';
import { ResourceLike, resourceOwnerId } from '../../common/authorization/access-policy.service';
import type { EmitNotificationInput } from './notifications.service';

/**
 * Who hears about something that happened to one resource (a gateway's
 * domain stopped being served, an outside workspace installed it).
 *
 * The org's owners and admins, as a rule -- they see every org and team
 * resource. A private resource is its owner's alone, admins included in
 * "nobody else" (AccessPolicyService.canAccess), so the event goes to the
 * owner and nobody else: an admin told "chat.acme.com is no longer
 * served" with a link to the gateway learns that a "just me" gateway
 * exists, what it is called and where it is published. A private row
 * with no recorded owner is nobody's: null, send nothing.
 */
export function resourceAudience(
  resource: Pick<ResourceLike, 'visibility' | 'ownerUserId' | 'createdBy'>,
): Pick<EmitNotificationInput, 'userIds' | 'roleTarget'> | null {
  if (resource.visibility === 'private') {
    const owner = resourceOwnerId(resource);
    return owner ? { userIds: [owner] } : null;
  }
  return { roleTarget: { orgRoles: [OrganizationRole.OWNER, OrganizationRole.ADMIN] } };
}
