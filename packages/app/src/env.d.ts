/// <reference types="vite/client" />
/// <reference path="./vendor/telegram-web-app.d.ts" />

interface ImportMetaEnv {
  readonly VITE_TELEGRAM_BOT_ID: string
  readonly VITE_TELEGRAM_PUBLIC_KEY: string;
  readonly VITE_LIT_APP_WALLET_SECRET: string;
  readonly VITE_GHOST_IPFSCID: string;
  readonly VITE_LIT_NETWORK: string;
  readonly VITE_PYUSD_TOKEN_ADDRESS: string;
  readonly VITE_CHAIN: string;
  readonly VITE_CHAIN_ID: string;
  readonly VITE_CONTRACT_TOKEN: string;
  readonly VITE_CONTRACT_LITGHOST: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
