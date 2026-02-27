<!--
    IGC file loader — file picker + drag-and-drop.
    Dispatches a 'load' event with { filename, text } when a file is read.
-->
<div
    class="file-loader"
    class:dragging
    on:dragover|preventDefault={() => (dragging = true)}
    on:dragleave={() => (dragging = false)}
    on:drop|preventDefault={handleDrop}
>
    <label class="file-loader__label clickable">
        <input
            type="file"
            accept=".igc,.IGC"
            on:change={handleFileInput}
            style="display:none"
        />
        {#if loading}
            <span class="size-s">Parsing...</span>
        {:else}
            <span class="size-s">Drop IGC file here or <u>browse</u></span>
        {/if}
    </label>
</div>

<script lang="ts">
    import { createEventDispatcher } from 'svelte';

    const dispatch = createEventDispatcher<{
        load: { filename: string; text: string };
    }>();

    let dragging = false;
    let loading = false;

    async function readFile(file: File) {
        loading = true;
        try {
            const text = await file.text();
            dispatch('load', { filename: file.name, text });
        } finally {
            loading = false;
        }
    }

    function handleFileInput(e: Event) {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        if (file) readFile(file);
    }

    function handleDrop(e: DragEvent) {
        dragging = false;
        const file = e.dataTransfer?.files?.[0];
        if (file && file.name.toLowerCase().endsWith('.igc')) {
            readFile(file);
        }
    }
</script>

<style lang="less">
    .file-loader {
        border: 2px dashed rgba(255, 255, 255, 0.3);
        border-radius: 8px;
        padding: 20px;
        text-align: center;
        transition: border-color 0.2s;
        cursor: pointer;

        &.dragging,
        &:hover {
            border-color: rgba(255, 255, 255, 0.7);
        }

        &__label {
            display: block;
            cursor: pointer;
        }
    }
</style>
