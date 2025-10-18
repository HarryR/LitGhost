// XXX: lit protocol barfs without this!
window.global ||= window;

import { createApp } from 'vue'
import './assets/index.css'
import { detectTg } from './detectTg';

async function initApp() {
  if (detectTg()) {
    // Initialize Telegram SDK only when in Telegram
    const { init, initData } = await import('@telegram-apps/sdk-vue')
    init()
    initData.restore()

    const { default: TelegramMiniApp } = await import('./TelegramMiniApp.vue')
    createApp(TelegramMiniApp).mount('#app')
  } else {
    // Mount web app for browser usage
    const { default: WebApp } = await import('./WebApp.vue')
    createApp(WebApp).mount('#app')
  }
}

initApp()
