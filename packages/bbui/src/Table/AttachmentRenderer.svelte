<script>
  import Tooltip from "../Tooltip/Tooltip.svelte"
  import Link from "../Link/Link.svelte"

  export let value

  const displayLimit = 5
  $: attachments = value?.slice(0, displayLimit) ?? []
  $: leftover = (value?.length ?? 0) - attachments.length

  const imageExtensions = ["png", "tiff", "gif", "raw", "jpg", "jpeg"]
  const isImage = extension => {
    return imageExtensions.includes(extension?.toLowerCase())
  }
</script>

{#each attachments as attachment}
  {#if isImage(attachment.extension)}
    <Link quiet target="_blank" href={attachment.url}>
      <div class="center">
        <img src={attachment.url} alt={attachment.extension} />
      </div>
    </Link>
  {:else}
    <Tooltip text={attachment.name} direction="right">
      <div class="file">
        <Link quiet target="_blank" href={attachment.url}>
          {attachment.extension}
        </Link>
      </div>
    </Tooltip>
  {/if}
{/each}
{#if leftover}
  <div>+{leftover} more</div>
{/if}

<style>
  img {
    height: 32px;
    max-width: 64px;
  }
  .center,
  .file {
    display: flex;
    flex-direction: row;
    justify-content: flex-start;
    align-items: center;
  }
  .file {
    height: 32px;
    padding: 0 8px;
    color: var(--spectrum-global-color-gray-800);
    border: 1px solid var(--spectrum-global-color-gray-300);
    border-radius: 2px;
    text-transform: uppercase;
    font-weight: 600;
    font-size: 11px;
  }
</style>
