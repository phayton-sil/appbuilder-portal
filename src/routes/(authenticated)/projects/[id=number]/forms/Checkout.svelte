<script lang="ts">
  import type { Prisma } from '@prisma/client';
  import type { SubmitFunction } from '@sveltejs/kit';
  import { enhance } from '$app/forms';
  import BlockIfJobsUnavailable from '$lib/components/BlockIfJobsUnavailable.svelte';
  import CancelButton from '$lib/components/settings/CancelButton.svelte';
  import IconButton from '$lib/components/settings/IconButton.svelte';
  import { Icons } from '$lib/icons';
  import IconContainer from '$lib/icons/IconContainer.svelte';
  import { m } from '$lib/paraglide/messages';
  import type { projectCheckoutSelect } from '$lib/projects';
  import { toast } from '$lib/utils';
  import { getTimeDateString } from '$lib/utils/time';

  interface Props {
    checkout: Prisma.ProjectsGetPayload<{ select: typeof projectCheckoutSelect }>;
    userId: number;
    endpoint: string;
    allowOverwriteEndpoint: string;
    cancelOverwriteEndpoint: string;
    // Overwriting only needs to be allowed where uploads need the checkout
    checkoutRequired: boolean;
    canEdit: boolean;
  }

  let {
    checkout,
    userId,
    endpoint,
    allowOverwriteEndpoint,
    cancelOverwriteEndpoint,
    checkoutRequired,
    canEdit
  }: Props = $props();

  let unlockModal: HTMLDialogElement | undefined = $state(undefined);

  const isHolder = $derived(checkout.CheckedOutById === userId);
  const holderName = $derived(
    checkout.CheckedOutBy?.Name ?? `User #${checkout.CheckedOutById ?? ''}`
  );

  const onSubmit: SubmitFunction =
    () =>
    ({ update, result }) => {
      if (result.type === 'error') {
        if (result.status === 503) {
          toast('error', m.system_unavailable());
        }
      }
      update({ reset: false });
    };
</script>

<div class="card border border-slate-400 overflow-hidden rounded-md max-w-full">
  <div class="bg-neutral">
    <h2>{m.project_checkout_title()}</h2>
  </div>
  <div class="p-2">
    {#if checkout.CheckedOutById !== null}
      <div class="flex flex-row w-full place-content-between items-center gap-2 p-2">
        <div class="flex flex-row items-center gap-2 min-w-0">
          <IconContainer icon={Icons.Locked} width={24} />
          <div class="min-w-0">
            <div>{m.project_checkout_by({ name: holderName })}</div>
            <div class="text-sm opacity-70">
              {m.project_checkout_since({ date: getTimeDateString(checkout.DateCheckedOut) })}
            </div>
          </div>
        </div>
        {#if isHolder}
          <form action="?/{endpoint}" method="post" use:enhance={onSubmit}>
            <BlockIfJobsUnavailable class="btn btn-secondary">
              {#snippet altContent()}
                <IconContainer icon={Icons.Unlocked} width={20} />
                {m.project_checkout_checkIn()}
              {/snippet}
              <IconButton
                type="submit"
                class="btn-secondary"
                icon={Icons.Unlocked}
                key="project_checkout_checkIn"
              />
            </BlockIfJobsUnavailable>
          </form>
        {:else if canEdit}
          <BlockIfJobsUnavailable class="btn btn-warning">
            {#snippet altContent()}
              <IconContainer icon={Icons.Unlocked} width={20} />
              {m.project_checkout_unlock()}
            {/snippet}
            <button class="btn btn-warning" onclick={() => unlockModal?.showModal()}>
              {@render altContent()}
            </button>
          </BlockIfJobsUnavailable>
        {/if}
      </div>
    {:else}
      <div class="flex flex-row items-center gap-2 p-2">
        <IconContainer icon={Icons.Unlocked} width={24} />
        {m.project_checkout_none()}
      </div>
    {/if}
    {#if checkout.OverwriteAllowedById !== null}
      <div class="flex flex-row items-center gap-2 border-2 border-warning rounded-md p-2 m-2">
        <IconContainer icon={Icons.Overwrite} width={24} />
        <div class="grow min-w-0">
          {m.project_checkout_overwriteAllowed({
            name: checkout.OverwriteAllowedBy?.Name ?? `User #${checkout.OverwriteAllowedById}`,
            date: getTimeDateString(checkout.DateOverwriteAllowed)
          })}
        </div>
        {#if canEdit}
          <form action="?/{cancelOverwriteEndpoint}" method="post" use:enhance={onSubmit}>
            <BlockIfJobsUnavailable class="btn btn-secondary">
              {#snippet altContent()}
                <IconContainer icon={Icons.Close} width={20} />
                {m.common_cancel()}
              {/snippet}
              <IconButton
                type="submit"
                class="btn-secondary"
                icon={Icons.Close}
                key="common_cancel"
              />
            </BlockIfJobsUnavailable>
          </form>
        {/if}
      </div>
    {:else if canEdit && checkoutRequired}
      <form
        class="p-2"
        action="?/{allowOverwriteEndpoint}"
        method="post"
        use:enhance={onSubmit}
        title={m.project_checkout_allowOverwriteHelp()}
      >
        <BlockIfJobsUnavailable class="btn btn-outline btn-warning">
          {#snippet altContent()}
            <IconContainer icon={Icons.Overwrite} width={20} />
            {m.project_checkout_allowOverwrite()}
          {/snippet}
          <IconButton
            type="submit"
            class="btn-outline btn-warning"
            icon={Icons.Overwrite}
            key="project_checkout_allowOverwrite"
          />
        </BlockIfJobsUnavailable>
      </form>
    {/if}
  </div>
</div>

{#if canEdit && !isHolder}
  <dialog bind:this={unlockModal} class="modal">
    <form class="modal-box" action="?/{endpoint}" method="post" use:enhance={onSubmit}>
      <h2 class="text-lg font-bold text-center">{m.project_checkout_unlockTitle()}</h2>
      <div class="border-2 border-warning p-2 my-4 w-full rounded-md">
        {m.project_checkout_unlockWarning({ name: holderName })}
      </div>
      <div class="flex flex-row gap-2 justify-center">
        <CancelButton onclick={() => unlockModal?.close()} />
        <IconButton
          type="submit"
          class="btn-warning"
          icon={Icons.Unlocked}
          key="project_checkout_unlock"
          onclick={() => unlockModal?.close()}
        />
      </div>
    </form>
    <form method="dialog" class="modal-backdrop">
      <button>{m.common_close()}</button>
    </form>
  </dialog>
{/if}
