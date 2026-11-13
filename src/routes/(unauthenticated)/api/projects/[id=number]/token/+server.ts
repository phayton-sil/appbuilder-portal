import { json } from '@sveltejs/kit';
import {
  createAppBuildersError,
  createCheckedOutError,
  hasBeenUploaded,
  hasRepositoryWriteAccess,
  isCheckoutRequired
} from '../common';
import { ProjectActionType } from '$lib/prisma';
import { projectCheckoutSelect } from '$lib/projects';
import { BuildEngine } from '$lib/server/build-engine-api';
import { DatabaseReads, DatabaseWrites } from '$lib/server/database';

const TOKEN_USE_HEADER = 'Use';
const TOKEN_USE_UPLOAD = 'Upload';
const TOKEN_USE_STATUS = 'Status';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const TOKEN_USE_DOWNLOAD = 'Download';

export async function POST({ params, locals, request }) {
  try {
    locals.security.requireApiToken();
  } catch {
    return createAppBuildersError(401, 'Login timed out');
  }

  const user = await DatabaseReads.users.findUniqueOrThrow({
    where: { Id: locals.security.userId },
    select: {
      Id: true,
      Name: true,
      Email: true
    }
  });

  const projectId = parseInt(params.id);

  const tokenUse = request.headers.get(TOKEN_USE_HEADER);

  const project = await DatabaseReads.projects.findUnique({
    where: {
      Id: projectId
    },
    select: {
      RepositoryUrl: true,
      BuildEngineProjectId: true,
      OwnerId: true,
      Owner: {
        select: {
          Id: true,
          ExternalId: true
        }
      },
      Authors: {
        select: {
          UserId: true
        }
      },
      OrganizationId: true,
      ...projectCheckoutSelect
    }
  });
  if (!project) return createAppBuildersError(404, `Project id=${projectId} not found`);

  if (!project.RepositoryUrl)
    return createAppBuildersError(404, `Project id=${projectId}: RepositoryUrl is null`);

  if (!hasRepositoryWriteAccess(locals.security, project))
    return createAppBuildersError(
      403,
      `Project id=${projectId}, user='${user.Name}' with email='${user.Email}' does not have permission to access`
    );

  // While someone else has the project checked out, everyone else gets read-only access
  const checkedOutByOther =
    project.CheckedOutById !== null && project.CheckedOutById !== locals.security.userId;
  let readOnly = checkedOutByOther;
  let mustCheckOut = false;

  // Where checkout is required, uploading without the checkout could overwrite someone's work.
  // Only an upload that can't do that is allowed: the project's first upload,
  // or one that an owner or admin has allowed to overwrite the current version.
  if (
    !readOnly &&
    project.CheckedOutById !== locals.security.userId &&
    (await isCheckoutRequired(project.OrganizationId))
  ) {
    readOnly = !(
      tokenUse === TOKEN_USE_UPLOAD &&
      (project.OverwriteAllowedById !== null || !(await hasBeenUploaded(projectId)))
    );
    mustCheckOut = readOnly;
  }

  if (tokenUse && tokenUse === TOKEN_USE_UPLOAD && checkedOutByOther)
    return createCheckedOutError(projectId, project);

  if (tokenUse && tokenUse === TOKEN_USE_UPLOAD && mustCheckOut)
    return createAppBuildersError(
      409,
      `Project id=${projectId} must be checked out before uploading changes, so that they are made to the latest version`
    );

  const tokenResult = await BuildEngine.Requests.getProjectAccessToken(
    { type: 'query', organizationId: project.OrganizationId },
    project.BuildEngineProjectId,
    {
      name: project.Owner.ExternalId ?? '',
      ReadOnly: readOnly
    }
  );

  if (!tokenResult || tokenResult.responseType === 'error')
    return createAppBuildersError(400, `Project id=${projectId}: GetProjectToken returned null`);
  if (tokenResult.SecretAccessKey == null)
    return createAppBuildersError(400, `Project id=${projectId}: Token.SecretAccessKey is null`);
  const projectToken = {
    type: 'project-tokens',
    attributes: {
      id: projectId,
      url: project.RepositoryUrl,
      'session-token': tokenResult.SessionToken,
      'secret-access-key': tokenResult.SecretAccessKey,
      'access-key-id': tokenResult.AccessKeyId,
      expiration: tokenResult.Expiration,
      region: tokenResult.Region,
      'read-only': tokenResult.ReadOnly
    }
  };

  let use = readOnly ? 'ReadOnly Access' : 'ReadWrite Access';

  if (tokenUse) {
    use = tokenUse;
  }

  if (use !== TOKEN_USE_STATUS) {
    await DatabaseWrites.projectActions.create({
      ProjectId: projectId,
      UserId: user.Id,
      ActionType: ProjectActionType.Access,
      Action: use
    });
  }

  // An owner or admin may have allowed this upload to replace the current version
  if (tokenUse === TOKEN_USE_UPLOAD && project.OverwriteAllowedById !== null) {
    await DatabaseWrites.projects.useOverwrite(projectId, user.Id);
  }

  return json({ data: projectToken });
}
