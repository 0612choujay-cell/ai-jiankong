<template>
  <div class="lightbox" role="dialog" aria-modal="true" @click.stop="$emit('close')">
    <img :src="photo" :alt="caption">
    <p>{{ caption }}</p>
    <button type="button" class="primary" @click.stop="$emit('close')">關閉</button>
  </div>
</template>

<script setup>
defineProps({
  photo: { type: String, required: true },
  caption: { type: String, default: '' },
})
defineEmits(['close'])
</script>

<style scoped>
.lightbox { position: fixed; inset: 0; z-index: 30; display: flex; flex-direction: column;
  align-items: center; justify-content: center; gap: 12px; padding: 16px;
  background: rgba(0, 0, 0, .9); color: #fff; }
.lightbox img { max-width: 100%; max-height: 80vh; border-radius: 8px; }
</style>
