import { json } from '@sveltejs/kit';
import {
  createAppBuildersError,
  createCheckedOutError,
  hasBeenUploaded,
  hasRepositoryWriteAccess,
  isCheckoutRequired
} from '../common';
import { projectCheckoutSelect } from '$lib/projects';
import { DatabaseReads, DatabaseWrites } from '$lib/server/database';

// App Builder checks out a project before making changes and checks it in once they are uploaded.
// While one user has a project checked out, nobody else can check it out or get an upload token.
// The project owner or an org admin can unlock a forgotten checkout from the project page.
// Where an org requires checkout, nobody can upload without the checkout, except for a project's
// first upload or an upload that an owner or admin has allowed to overwrite the current version.

// GET: who has the project checked out, if anyone
export async function GET({ params, locals }) {
  try {
    locals.security.requireApiToken();
  } catch {
    return createAppBuildersError(401, 'Login timed out');
  }
  const result = await getProject(parseInt(params.id), locals.security);
  if (result instanceof Response) return result;
  return checkoutResponse(result, result, locals.security.userId);
}

// POST: check out the project. Succeeds if the user already has it checked out
export async function POST({ params, locals }) {
  try {
    locals.security.requireApiToken();
  } catch {
    return createAppBuildersError(401, 'Login timed out');
  }
  const result = await getProject(parseInt(params.id), locals.security);
  if (result instanceof Response) return result;
  if (result.DateArchived)
    return createAppBuildersError(400, `Project id=${result.Id} is archived`);

  const checkout = await DatabaseWrites.projects.checkOut(result.Id, locals.security.userId);
  if (checkout.CheckedOutById !== locals.security.userId)
    return createCheckedOutError(result.Id, checkout);

  return checkoutResponse(result, checkout, locals.security.userId);
}

// DELETE: check in the project. Succeeds if nobody has it checked out
export async function DELETE({ params, locals }) {
  try {
    locals.security.requireApiToken();
  } catch {
    return createAppBuildersError(401, 'Login timed out');
  }
  const result = await getProject(parseInt(params.id), locals.security);
  if (result instanceof Response) return result;

  if (result.CheckedOutById !== null && result.CheckedOutById !== locals.security.userId)
    return createCheckedOutError(result.Id, result);

  await DatabaseWrites.projects.checkIn(result.Id, locals.security.userId);

  return checkoutResponse(
    result,
    { ...result, CheckedOutById: null, DateCheckedOut: null, CheckedOutBy: null },
    locals.security.userId
  );
}

// Returns the project if the user can push changes to it, otherwise an error response
async function getProject(projectId: number, security: Security) {
  const project = await DatabaseReads.projects.findUnique({
    where: { Id: projectId },
    select: {
      Id: true,
      OwnerId: true,
      OrganizationId: true,
      DateArchived: true,
      Authors: { select: { UserId: true } },
      ...projectCheckoutSelect
    }
  });
  if (!project) return createAppBuildersError(404, `Project id=${projectId} not found`);

  if (!hasRepositoryWriteAccess(security, project))
    return createAppBuildersError(
      403,
      `Project id=${projectId}: user does not have permission to check out this project`
    );

  return project;
}

async function checkoutResponse(
  project: { Id: number; OrganizationId: number },
  checkout: {
    CheckedOutById: number | null;
    DateCheckedOut: Date | null;
    CheckedOutBy: { Name: string | null } | null;
    OverwriteAllowedById: number | null;
  },
  userId: number
) {
  return json({
    data: {
      type: 'project-checkouts',
      attributes: {
        id: project.Id,
        'checked-out': checkout.CheckedOutById !== null,
        'checked-out-by-id': checkout.CheckedOutById,
        'checked-out-by-name': checkout.CheckedOutBy?.Name ?? null,
        'date-checked-out': checkout.DateCheckedOut,
        'checked-out-by-me': checkout.CheckedOutById === userId,
        // The next upload may replace the current version without a checkout
        'overwrite-allowed': checkout.OverwriteAllowedById !== null,
        // Whether uploading needs the checkout, and if so whether this would be the first upload
        'checkout-required': await isCheckoutRequired(project.OrganizationId),
        'has-been-uploaded': await hasBeenUploaded(project.Id)
      }
    }
  });
}
