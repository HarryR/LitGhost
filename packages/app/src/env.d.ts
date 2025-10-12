/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_TELEGRAM_BOT_ID: string
  readonly VITE_TELEGRAM_PUBLIC_KEY: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}

// Telegram WebApp types
interface Window {
  Telegram?: {
    WebApp?: unknown
  }
}
