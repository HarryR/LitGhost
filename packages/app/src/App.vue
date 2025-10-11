<script setup lang="ts">
import { ref } from 'vue'

const count = ref(0)
</script>

<template>
  <div>
    <h1>Vite + Vue + TypeScript</h1>
    <button @click="count++">Count is: {{ count }}</button>
  </div>
</template>

<style scoped>
h1 {
  color: #42b883;
}
</style>
