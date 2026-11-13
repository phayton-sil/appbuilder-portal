import type { Prisma } from '@prisma/client';
import { ProjectActionType, RoleId } from '$lib/prisma';
import { DatabaseReads } from '$lib/server/database';
import { getSiteParam } from '$lib/site-params/server';

// Creates a standardized AppBuilders error response
export function createAppBuildersError(status: number, title: string) {
  return new Response(JSON.stringify({ errors: [{ title }] }), { status });
}

// filter for rebuildable products
export function rebuildableProductsWhere(projectId: number, ownerId: number) {
  return {
    ProjectId: projectId,
    Project: { Owner: { Id: ownerId } },
    DatePublished: { not: null },
    PublishLink: { not: null },
    WorkflowInstance: null,
    ProductDefinition: { RebuildWorkflowId: { not: null } }
  } satisfies Prisma.ProductsWhereInput;
}

// Whether the user can push changes to the project's repository from App Builder:
// the project owner, an admin of its organization, or one of its authors
export function hasRepositoryWriteAccess(
  security: Security,
  project: { OwnerId: number; OrganizationId: number; Authors: { UserId: number }[] }
) {
  if (security.userId === project.OwnerId) return true;
  try {
    security.requireAdminOfOrg(project.OrganizationId);
    return true;
  } catch {
    /* empty */
  }
  try {
    security.requireHasRole(project.OrganizationId, RoleId.Author, false);
    // ISSUE: #1101 Kalaam now wants authors to be able to update at any time.  In the future, we can add a setting on the author to whether they are a restricted author or not. I don't have time to add the UI at the moment.
    //return author.CanUpdate;
    return project.Authors.some(({ UserId }) => UserId === security.userId);
  } catch {
    return false;
  }
}

// Error response for when someone else has the project checked out in App Builder
export function createCheckedOutError(
  projectId: number,
  checkout: { CheckedOutBy: { Name: string | null } | null; DateCheckedOut: Date | null }
) {
  return createAppBuildersError(
    409,
    `Project id=${projectId} is checked out by '${checkout.CheckedOutBy?.Name}' since ${checkout.DateCheckedOut?.toISOString()}`
  );
}

// Whether the organization only allows uploads to projects that the user has checked out
export async function isCheckoutRequired(organizationId: number) {
  const allowList = await getSiteParam('projects', 'org-require-checkout');
  return allowList === 'all' || allowList.includes(organizationId);
}

// Whether App Builder has ever asked to upload to the project.
// Older records name the action 'Project Upload'.
export async function hasBeenUploaded(projectId: number) {
  return !!(await DatabaseReads.projectActions.count({
    where: {
      ProjectId: projectId,
      ActionType: ProjectActionType.Access,
      Action: { in: ['Upload', 'Project Upload'] }
    }
  }));
}
