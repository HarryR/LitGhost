import { createApp } from 'vue'
import App from './App.vue'

import { init } from '@telegram-apps/sdk-vue';
init();
import { initData  } from '@telegram-apps/sdk-vue';
initData.restore();

createApp(App).mount('#app')
