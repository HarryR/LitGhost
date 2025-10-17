/// <reference types="vite/client" />

import { LIT_NETWORK_VALUES } from '@lit-protocol/constants';

interface ImportMetaEnv {
  readonly VITE_TELEGRAM_BOT_ID: string
  readonly VITE_TELEGRAM_PUBLIC_KEY: string;
  readonly VITE_LIT_APP_WALLET_SECRET: string;
  readonly VITE_GHOST_IPFSCID: string;
  readonly VITE_LIT_NETWORK: LIT_NETWORK_VALUES;
  readonly VITE_PYUSD_TOKEN_ADDRESS: string;
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
