<script setup lang="ts">
import { ref } from 'vue'
import { initData  } from '@telegram-apps/sdk-vue';
const count = ref(0)

function hasTgUsername() {
  const params = new URLSearchParams(initData.raw());
  const userJson = params.get('user');
  if( userJson === null ) {
      throw new Error("No 'user' in initData!");
  }
  const user = JSON.parse(userJson);
  return typeof user.username === 'string';
}

// TODO: if there is no TG username, display a sad message to the user telling them to get a username!
</script>

<template>
  <div>
    <h1>Telegram Mini App</h1>
    <button @click="count++">Count is: {{ count }}</button>
    {{ initData.raw() }}
    <br />
  </div>
</template>

<style scoped>
h1 {
  color: #42b883;
}
</style>
