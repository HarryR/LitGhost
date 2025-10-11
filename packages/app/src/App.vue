<script setup lang="ts">
import { ref } from 'vue'
import { initData  } from '@telegram-apps/sdk-vue';
const count = ref(0)
</script>

<template>
  <div>
    <h1>Vite + Vue + TypeScript</h1>
    <button @click="count++">Count is: {{ count }}</button>
    {{ initData.raw() }}
  </div>
</template>

<style scoped>
h1 {
  color: #42b883;
}
</style>
