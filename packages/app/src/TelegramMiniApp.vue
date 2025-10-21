<script setup lang="ts">
import { computed, watch, toRef, ref } from 'vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion'
import { useGhostClient } from './composables/useGhostClient'
import { useTelegramRegistration } from './composables/useTelegramRegistration'
import PrivateBalanceManager from './components/PrivateBalanceManager.vue'
import QRCode from 'qrcode'
import '@/vendor/telegram-web-app.d.ts'
import { JsonRpcProvider } from '@ethersproject/providers'
import { LitGhost } from '@monorepo/core'

// Create RPC provider for reading blockchain data
const rpcProvider = new JsonRpcProvider(import.meta.env.VITE_RPC_URL)

// Create read-only LitGhost contract instance
const litGhostContract = LitGhost.attach(import.meta.env.VITE_CONTRACT_LITGHOST).connect(rpcProvider)

// Fetch TEE public key from contract
const teePublicKey = ref<string | null>(null)
litGhostContract.getEntropy().then((entropy: any) => {
  teePublicKey.value = entropy.teeEncPublicKey
}).catch((error: Error) => {
  console.error('Failed to fetch TEE public key:', error)
})

// GhostClient - auto-connects on mount
const {
  client: gc,
  isLoading: gcLoading,
  status: gcStatus
} = useGhostClient({ debug: true });

// Telegram registration - handles private key storage
const {
  privateKey,
  isLoading: registrationLoading,
  error: registrationError,
  wasRegistered,
  storageType,
  register,
  clearStorage
} = useTelegramRegistration(toRef(gc));

const isClearingStorage = ref(false);
async function handleClearStorage() {
  isClearingStorage.value = true;
  try {
    await clearStorage();
  } finally {
    isClearingStorage.value = false;
  }
}

// Export Private Key functionality
const isPrivateKeyExported = ref(false);
const isCopied = ref(false);
const qrCodeDataUrl = ref<string>('');

async function handleExportPrivateKey() {
  isPrivateKeyExported.value = true;

  // Generate QR code data URL
  if (qrCodeUrl.value) {
    try {
      qrCodeDataUrl.value = await QRCode.toDataURL(qrCodeUrl.value, {
        errorCorrectionLevel: 'H',
        width: 200,
        margin: 2,
      });
    } catch (err) {
      console.error('Failed to generate QR code:', err);
    }
  }
}

const formattedPrivateKey = computed(() => {
  if (!privateKey.value) return '';
  // Remove 0x prefix if present
  const hex = privateKey.value.startsWith('0x') ? privateKey.value.slice(2) : privateKey.value;
  // Split into 2-byte (4 character) chunks
  const chunks = hex.match(/.{1,4}/g) || [];
  return chunks.join(' ');
});

// Generate QR code URL with secret in hash parameter
const qrCodeUrl = computed(() => {
  if (!privateKey.value) return '';
  // Get the current page URL without query string and hash
  const baseUrl = window.location.origin + window.location.pathname;
  // Add the secret key as a hash parameter
  return `${baseUrl}#sk=${privateKey.value}`;
});

async function copyToClipboard() {
  if (privateKey.value) {
    try {
      await navigator.clipboard.writeText(privateKey.value);
      isCopied.value = true;
      setTimeout(() => {
        isCopied.value = false;
      }, 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  }
}

const telegramUser = computed(() => {
  return window.Telegram.WebApp.initDataUnsafe.user || null;
});

const hasUsername = computed(() => {
  return telegramUser.value && typeof telegramUser.value.username === 'string';
});

// Auto-register when ghost client is ready
watch(gc, async (client) => {
  if (client && hasUsername.value && !privateKey.value && !registrationLoading.value) {
    await register();
  }
}, { immediate: true });

// Show if we're waiting for ghost client or registration
const isLoading = computed(() => gcLoading.value || registrationLoading.value);
</script>

<template>
  <div class="min-h-screen bg-background">
    <!-- Top Bar -->
    <div class="border-b border-border bg-card">
      <div class="max-w-4xl mx-auto px-6 py-4">
        <div class="flex items-center justify-between">
          <!-- Logo -->
          <div class="flex items-center gap-2">
            <span class="text-3xl">🔥👻</span>
          </div>

          <!-- Lit Status -->
          <Badge
            variant="outline"
            :class="[gcStatus.class, 'px-3 py-1.5 font-medium']"
          >
            <span class="w-2 h-2 rounded-full mr-2" :class="gcStatus.dotClass"></span>
            {{ gcStatus.text }}
          </Badge>
        </div>
      </div>
    </div>

    <!-- Main Content -->
    <div class="max-w-4xl mx-auto px-6 py-8 space-y-6">
      <!-- Username Check Card -->
      <Card v-if="!hasUsername">
        <CardHeader>
          <div class="flex items-center justify-between">
            <CardTitle class="flex items-center gap-2">
              <span class="text-3xl">⚠️</span>
              Username Required
            </CardTitle>
            <Badge variant="destructive">Action Required</Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div class="text-center py-8 space-y-6">
            <div class="w-20 h-20 mx-auto bg-destructive/10 rounded-full flex items-center justify-center text-4xl mb-4">
              😔
            </div>
            <div class="space-y-4">
              <h3 class="text-xl font-semibold">Telegram Username Not Found</h3>
              <p class="text-muted-foreground">
                This app requires a Telegram username to function properly.
              </p>
              <div class="bg-muted p-4 rounded-lg text-left space-y-2 max-w-md mx-auto">
                <p class="font-semibold text-sm">To set up your username:</p>
                <ol class="list-decimal list-inside space-y-1 text-sm text-muted-foreground">
                  <li>Open Telegram Settings</li>
                  <li>Tap on your name at the top</li>
                  <li>Tap "Username" and create a unique username</li>
                  <li>Completely close and restart Telegram</li>
                  <li>Open this app again</li>
                </ol>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <!-- Loading/Error State (while waiting for GhostClient or registration) -->
      <Card v-else-if="isLoading || registrationError">
        <CardContent class="text-center py-8">
          <!-- Error State -->
          <template v-if="registrationError">
            <div class="w-20 h-20 mt-8 mx-auto bg-destructive/10 rounded-full flex items-center justify-center text-4xl mb-4">
              ❌
            </div>
            <h3 class="text-xl font-semibold mb-2">Login Failed</h3>
            <p class="text-muted-foreground max-w-md mx-auto">
              {{ registrationError }}
            </p>
          </template>

          <!-- Loading State -->
          <template v-else>
            <div class="w-16 h-16 mt-8 mx-auto mb-4 border-4 border-primary border-t-transparent rounded-full animate-spin"></div>
            <p class="text-muted-foreground">
              {{ gcLoading ? 'Connecting to Lit Network...' : 'Logging In...' }}
            </p>
          </template>
        </CardContent>
      </Card>

      <!-- Private Balance Manager -->
      <PrivateBalanceManager
        v-if="!isLoading"
        :ghost-client="gc"
        :private-key="privateKey"
        :provider="rpcProvider"
        :lit-ghost-contract="litGhostContract"
        :tee-public-key="teePublicKey"
      />

      <!-- FAQ & Utilities Accordion (only shown when registered) -->
      <div v-if="privateKey && !isLoading">
        <Accordion type="single" collapsible class="w-full">
          <AccordionItem value="export-key">
            <AccordionTrigger class="text-left">
              <span class="font-medium">Export LitGhost Secret</span>
            </AccordionTrigger>
            <AccordionContent>
              <div class="space-y-4 pt-2">
                <!-- Export Button or Copy Button -->
                <div v-if="!isPrivateKeyExported">
                  <Button
                    variant="destructive"
                    class="w-full"
                    @click="handleExportPrivateKey"
                  >
                    Export LitGhost Secret
                  </Button>
                </div>
                <div v-else>
                  <Button
                    variant="destructive"
                    class="w-full"
                    @click="copyToClipboard"
                  >
                    <span v-if="isCopied">✓ Copied to Clipboard</span>
                    <span v-else>📋 Copy to Clipboard</span>
                  </Button>
                </div>

                <!-- Private Key Display (shown after export) -->
                <div v-if="isPrivateKeyExported" class="space-y-4">
                  <p class="text-xs text-muted-foreground text-center">
                    ⚠️ Keep your LitGhost secret secure and never share it with anyone.
                  </p>

                  <!-- Hex Display -->
                  <div class="bg-muted rounded-md p-3">
                    <p class="font-mono text-xs text-foreground text-center leading-relaxed">
                      {{ formattedPrivateKey }}
                    </p>
                  </div>                  

                  <!-- QR Code -->
                  <div v-if="qrCodeDataUrl">
                    <p class="text-xs text-muted-foreground text-center">
                      Or, scan this QR code with your phone to <a :href="qrCodeUrl" target="_blank" class="underline">open the Web App with your secret pre-loaded</a>
                    </p>

                    <div class="bg-white rounded-md p-4 mt-4 flex justify-center">
                      <img :src="qrCodeDataUrl" alt="QR Code" class="w-[200px] h-[200px]" />
                    </div>
                  </div>         
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>

          <!-- Storage Management (Debug) -->
          <AccordionItem value="storage-management">
            <AccordionTrigger class="text-left">
              <span class="font-medium">Storage Management (Debug)</span>
            </AccordionTrigger>
            <AccordionContent>
              <div class="space-y-4 pt-2">
                <p class="text-sm text-muted-foreground">
                  Manage your stored private key and view storage status. Useful for debugging.
                </p>

                <!-- Storage Status -->
                <div class="bg-muted rounded-md p-4 space-y-3">
                  <div class="flex items-center gap-2 text-sm">
                    <span class="text-muted-foreground">Registration Status:</span>
                    <Badge variant="outline" class="gap-1">
                      <span v-if="wasRegistered">🆕 Newly Registered</span>
                      <span v-else>💾 Loaded from Storage</span>
                    </Badge>
                  </div>
                  <div class="flex items-center gap-2 text-sm">
                    <span class="text-muted-foreground">Storage Type:</span>
                    <Badge v-if="storageType" variant="secondary" class="gap-1">
                      <span v-if="storageType === 'secure'">🔐 SecureStorage</span>
                      <span v-else-if="storageType === 'device'">📱 DeviceStorage</span>
                      <span v-else>❓ {{ storageType }}</span>
                    </Badge>
                    <Badge v-else variant="outline">⏳ Storage Unknown</Badge>
                  </div>
                </div>

                <!-- Clear Storage Button -->
                <div class="space-y-2">
                  <Button
                    variant="destructive"
                    class="w-full"
                    @click="handleClearStorage"
                    :disabled="isClearingStorage"
                  >
                    <span v-if="isClearingStorage">🔄 Clearing...</span>
                    <span v-else>🗑️ Clear Storage</span>
                  </Button>
                  <p class="text-xs text-muted-foreground">
                    ⚠️ This will delete your stored private key. You can login again any any time by opening the app again.
                  </p>
                </div>
              </div>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </div>

      <!-- Footer -->
      <div class="text-center text-sm text-muted-foreground">
        Made with 🤎 @ ETH Global Online 2025
      </div>
    </div>

  </div>
</template>
