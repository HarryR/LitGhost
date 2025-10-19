<script setup lang="ts">
import { computed, watch, toRef } from 'vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useGhostClient } from './composables/useGhostClient'
import { useTelegramRegistration } from './composables/useTelegramRegistration'
import '@/vendor/telegram-web-app.d.ts'

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
  register
} = useTelegramRegistration(toRef(gc));

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

// Placeholder for PYUSD balance
const pyusdBalance = computed(() => '0.00');
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

      <!-- User Info Section (only shown when username exists and registered) -->
      <div v-else class="bg-card border border-border rounded-lg p-6">
        <div class="space-y-4">
          <!-- Username and Balance Row -->
          <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
            <div class="flex-1">
              <p class="text-sm text-muted-foreground mb-1">Username</p>
              <p class="font-mono text-lg">@{{ telegramUser?.username }}</p>
            </div>
            <div class="text-left sm:text-right">
              <p class="text-sm text-muted-foreground mb-1">PYUSD Balance</p>
              <p class="text-2xl font-bold">{{ pyusdBalance }} <span class="text-sm font-normal text-muted-foreground">PYUSD</span></p>
            </div>
          </div>

          <!-- Storage Status Row -->
          <div class="pt-4 border-t border-border">
            <div class="flex flex-wrap items-center gap-2 text-sm">
              <span class="text-muted-foreground">Status:</span>
              <Badge variant="outline" class="gap-1">
                <span v-if="wasRegistered">🆕 Newly Registered</span>
                <span v-else>💾 Loaded from Storage</span>
              </Badge>
              <Badge v-if="storageType" variant="secondary" class="gap-1">
                <span v-if="storageType === 'secure'">🔐 SecureStorage</span>
                <span v-else-if="storageType === 'device'">📱 DeviceStorage</span>
                <span v-else>❓ {{ storageType }}</span>
              </Badge>
              <Badge v-else variant="outline">⏳ Storage Unknown</Badge>
            </div>
          </div>
        </div>
      </div>

      <!-- Footer -->
      <div class="text-center text-sm text-muted-foreground">
        Made with 🤎 @ ETH Global Online 2025
      </div>
    </div>

  </div>
</template>
