<script setup lang="ts">
defineProps<{ message?: string; compact?: boolean }>()
</script>
<template><div role="alert">{{ message || '暂时无法加载，请重试。' }}</div></template>
