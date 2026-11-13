import { SpanStatusCode, trace } from '@opentelemetry/api';
import type { Prisma } from '@prisma/client';
import { BullMQ, getQueues } from '../bullmq/index';
import * as projectActions from './ProjectActions';
import prisma from './prisma';
import type { RequirePrimitive, TXClient } from './utility';
import { ProjectActionString, ProjectActionType, RoleId } from '$lib/prisma';
import { projectCheckoutSelect } from '$lib/projects';
import { manualVersionCodeMatch } from '$lib/workflowTypes';

/**
 * For a project to be valid:
 * 1. Each of the following must reference a valid relation (HANDLED BY POSTGRESQL)
 *  - OrganizationId => Organizations
 *  - GroupId => Groups
 *  - OwnerId => Users
 * 2. This project's group must have the same organization as the project itself
 *  - Group.OwnerId === OrganizationId
 * 3. The project's owner must be in the project's organization
 *  - Owner.OrganizationMemberships[].OrganizationId includes OrganizationId
 */

export async function create(
  projectData: RequirePrimitive<Prisma.ProjectsUncheckedCreateInput>
): Promise<false | number> {
  if (
    !(await validateProjectBase(
      projectData.OrganizationId,
      projectData.GroupId,
      projectData.OwnerId
    ))
  )
    return false;

  // No additional verification steps

  try {
    const res = await prisma.projects.create({
      data: projectData
    });
    return res.Id;
  } catch {
    return false;
  }
}

export async function update(
  id: number,
  projectData: RequirePrimitive<Prisma.ProjectsUncheckedUpdateInput>,
  txClient?: TXClient
): Promise<boolean> {
  const client = txClient ?? prisma;
  // There are cases where a db lookup is not necessary to verify that it will
  // be a legal relation after the update, such as if none of the relevant
  // columns are changed, but for simplicity we just lookup once anyway
  const existing = await client.projects.findUnique({
    where: {
      Id: id
    }
  });
  const orgId = projectData.OrganizationId ?? existing!.OrganizationId;
  const groupId = projectData.GroupId ?? existing!.GroupId;
  const ownerId = projectData.OwnerId ?? existing!.OwnerId;
  if (!(await validateProjectBase(orgId, groupId, ownerId, id, client))) return false;

  // No additional verification steps

  try {
    await client.projects.update({
      where: {
        Id: id
      },
      data: projectData
    });
    // If the owner has changed, we need to reassign all the user tasks related to this project
    if (ownerId && ownerId !== existing?.OwnerId) {
      await getQueues().UserTasks.add(`Reassign tasks for Project #${id} (New Owner)`, {
        type: BullMQ.JobType.UserTasks_Workflow,
        scope: 'Project',
        projectId: id,
        operation: {
          type: BullMQ.UserTasks.OpType.Reassign,
          userMapping: [{ from: existing!.OwnerId, to: ownerId, withRole: RoleId.AppBuilder }]
        }
      });
      await getQueues().UserTasks.add(
        `Reassign data deletion requests for Project #${id} (New Owner)`,
        {
          type: BullMQ.JobType.UserTasks_DeleteRequest,
          scope: 'Project',
          projectId: id,
          operation: {
            type: BullMQ.UserTasks.OpType.Reassign,
            userMapping: [{ from: existing!.OwnerId, to: ownerId, withRole: RoleId.AppBuilder }]
          }
        }
      );
    }
  } catch {
    return false;
  }
  getQueues().SvelteSSE.add(`Update Project #${id} (update details)`, {
    type: BullMQ.JobType.SvelteSSE_UpdateProject,
    projectIds: [id]
  });

  if (
    (projectData.RebuildOnSoftwareUpdate ?? existing!.RebuildOnSoftwareUpdate) !==
      existing!.RebuildOnSoftwareUpdate ||
    (projectData.Properties ?? existing!.Properties) !== existing!.Properties
  ) {
    getQueues().SvelteSSE.add(
      `Update Updatable Products (project #${id} changed eligibility (RebuildOnSoftwareUpdate: ${projectData.RebuildOnSoftwareUpdate}, Properties: ${projectData.Properties?.match(manualVersionCodeMatch)}))`,
      {
        type: BullMQ.JobType.SvelteSSE_UpdateUpdatableProducts,
        orgIds: [existing!.OrganizationId]
      }
    );
  }
  return true;
}

export async function createMany(projectData: RequirePrimitive<Prisma.ProjectsCreateManyInput>[]) {
  const valid = (
    await Promise.all(
      projectData.map((pd) => validateProjectBase(pd.OrganizationId, pd.GroupId, pd.OwnerId))
    )
  ).every((p) => p);

  try {
    if (valid) {
      return (
        await prisma.projects.createManyAndReturn({ data: projectData, select: { Id: true } })
      ).map((p) => p.Id);
    }
  } catch {
    return false;
  }

  return false;
}

// async function deleteProject(id: number): Promise<never> {
//   throw new Error('Should not be deleting a project, only archiving');
// }
// export { deleteProject as delete };

async function validateProjectBase(
  orgId: number,
  groupId: number,
  ownerId: number,
  projectId?: number,
  txClient?: TXClient
) {
  const client = txClient ?? prisma;
  // Each of the criteria for a valid project just needs to checked if
  // the relevant data is supplied. If it isn't, then this is an update
  // and the data was valid already, or PostgreSQL will catch it
  const user = await client.users.findUnique({
    where: { Id: ownerId },
    select: {
      Groups: { where: { Id: groupId } },
      Organizations: { where: { Id: orgId } },
      UserRoles: { where: { RoleId: RoleId.SuperAdmin } }
    }
  });
  /** owner must be a member of project group */
  const userInGroup = !!user?.Groups.length;
  /** owner must be a member of project org */
  const userInOrg = !!user?.Organizations.length;
  /** disregard owner restrictions if owner is Super Admin */
  const userIsSuperAdmin = !!user?.UserRoles.length;

  /* project group must be owned by project org */
  const orgOwnsGroup =
    orgId === (await client.groups.findUnique({ where: { Id: groupId } }))?.OwnerId;

  const check = orgOwnsGroup && ((userInGroup && userInOrg) || userIsSuperAdmin);

  if (!check) {
    const span = trace.getActiveSpan();
    if (span) {
      const msg = `Project validation failed for ${projectId || 'new project'}`;
      span.addEvent(msg, {
        'project.organization-id': orgId,
        'project.group-id': groupId,
        'project.owner-id': ownerId,
        'project.group-in-org': orgOwnsGroup,
        'project.user-in-group': userInGroup,
        'project.user-in-org': userInOrg
      });

      span.recordException(new Error(msg));
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: msg
      });
    }
  }

  return check;
}

export async function getUsersByRole(projectId: number, roles?: RoleId[]) {
  const users = await prisma.users.findMany({
    where: {
      OR: [
        {
          Projects: { some: { Id: projectId } }
        },
        {
          UserRoles: {
            some: {
              RoleId: RoleId.OrgAdmin,
              Organization: {
                Projects: {
                  some: { Id: projectId }
                }
              }
            }
          }
        },
        {
          Authors: { some: { ProjectId: projectId } }
        }
      ]
    },
    select: {
      Id: true,
      Projects: {
        where: {
          Id: projectId
        },
        select: {
          Id: true
        }
      },
      UserRoles: {
        where: {
          RoleId: RoleId.OrgAdmin,
          Organization: {
            Projects: {
              some: { Id: projectId }
            }
          }
        },
        select: {
          RoleId: true
        }
      },
      Authors: {
        where: {
          ProjectId: projectId
        },
        select: {
          UserId: true
        }
      }
    }
  });

  const includeOwner = !roles || roles.includes(RoleId.AppBuilder);
  const includeAdmin = !roles || roles.includes(RoleId.OrgAdmin);
  const includeAuthors = !roles || roles.includes(RoleId.Author);

  return new Map<number, Set<RoleId>>(
    (
      users.map((u) => [
        u.Id,
        new Set(
          [
            includeOwner && u.Projects.length && RoleId.AppBuilder,
            includeAdmin && u.UserRoles.length && RoleId.OrgAdmin,
            includeAuthors && u.Authors.length && RoleId.Author
          ].filter((r) => !!r)
        )
      ]) as [number, Set<RoleId>][]
    ).filter((u) => u[1].size)
  );
}

/**
 * Checks out a project so that only this user can upload changes from App Builder.
 * Does nothing if the project is already checked out, by this user or anyone else.
 * @returns the checkout state afterwards. The checkout succeeded iff `CheckedOutById === userId`
 */
export async function checkOut(projectId: number, userId: number) {
  // Matching on CheckedOutById: null makes this atomic, so two users can't both check out
  const res = await prisma.projects.updateMany({
    where: { Id: projectId, CheckedOutById: null },
    data: { CheckedOutById: userId, DateCheckedOut: new Date() }
  });
  if (res.count) {
    await projectActions.create({
      ProjectId: projectId,
      UserId: userId,
      ActionType: ProjectActionType.Checkout,
      Action: ProjectActionString.CheckOut
    });
  }
  return prisma.projects.findUniqueOrThrow({
    where: { Id: projectId },
    select: projectCheckoutSelect
  });
}

/**
 * Checks in a project that this user has checked out.
 * @returns false if the user did not have the project checked out
 */
export async function checkIn(projectId: number, userId: number) {
  const res = await prisma.projects.updateMany({
    where: { Id: projectId, CheckedOutById: userId },
    data: { CheckedOutById: null, DateCheckedOut: null }
  });
  if (res.count) {
    await projectActions.create({
      ProjectId: projectId,
      UserId: userId,
      ActionType: ProjectActionType.Checkout,
      Action: ProjectActionString.CheckIn
    });
  }
  return !!res.count;
}

/**
 * Releases whoever has the project checked out, e.g. if they forgot to check it in.
 * @returns false if the project was not checked out
 */
export async function unlock(projectId: number, unlockedById: number) {
  const { CheckedOutById } = await prisma.projects.findUniqueOrThrow({
    where: { Id: projectId },
    select: { CheckedOutById: true }
  });
  if (CheckedOutById === null) return false;
  // Only release the checkout we looked up, in case it changed in the meantime
  const res = await prisma.projects.updateMany({
    where: { Id: projectId, CheckedOutById },
    data: { CheckedOutById: null, DateCheckedOut: null }
  });
  if (res.count) {
    await projectActions.create({
      ProjectId: projectId,
      UserId: unlockedById,
      ActionType: ProjectActionType.Checkout,
      Action: ProjectActionString.Unlock,
      ExternalId: CheckedOutById
    });
  }
  return !!res.count;
}

/**
 * Lets the next upload replace the current version without a checkout.
 * Only the project owner or an org admin should be able to do this.
 */
export async function allowOverwrite(projectId: number, userId: number) {
  await prisma.projects.update({
    where: { Id: projectId },
    data: { OverwriteAllowedById: userId, DateOverwriteAllowed: new Date() }
  });
  await projectActions.create({
    ProjectId: projectId,
    UserId: userId,
    ActionType: ProjectActionType.Checkout,
    Action: ProjectActionString.AllowOverwrite
  });
}

/**
 * Withdraws permission for the next upload to replace the current version
 * @returns false if no overwrite was allowed
 */
export async function cancelOverwrite(projectId: number, userId: number) {
  const res = await prisma.projects.updateMany({
    where: { Id: projectId, OverwriteAllowedById: { not: null } },
    data: { OverwriteAllowedById: null, DateOverwriteAllowed: null }
  });
  if (res.count) {
    await projectActions.create({
      ProjectId: projectId,
      UserId: userId,
      ActionType: ProjectActionType.Checkout,
      Action: ProjectActionString.CancelOverwrite
    });
  }
  return !!res.count;
}

/**
 * Uses up the permission for an upload to replace the current version, if any,
 * once that upload has been given its credentials
 */
export async function useOverwrite(projectId: number, userId: number) {
  const { OverwriteAllowedById } = await prisma.projects.findUniqueOrThrow({
    where: { Id: projectId },
    select: { OverwriteAllowedById: true }
  });
  if (OverwriteAllowedById === null) return false;
  // Only one upload can use the permission, even if two start at the same time
  const res = await prisma.projects.updateMany({
    where: { Id: projectId, OverwriteAllowedById },
    data: { OverwriteAllowedById: null, DateOverwriteAllowed: null }
  });
  if (res.count) {
    await projectActions.create({
      ProjectId: projectId,
      UserId: userId,
      ActionType: ProjectActionType.Checkout,
      Action: ProjectActionString.OverwriteUsed,
      ExternalId: OverwriteAllowedById
    });
  }
  return !!res.count;
}
