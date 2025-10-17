// XXX: lit protocol barfs without this!
window.global ||= window;

import { createApp } from 'vue'
import './assets/index.css'

// Detect if running in Telegram environment
const isTelegram = (window as any).Telegram?.WebApp !== undefined

async function initApp() {
  if (isTelegram) {
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
