<script setup lang="ts">
import { ref, computed } from 'vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import '@/vendor/telegram-web-app.d.ts'

const count = ref(0)

const telegramUser = computed(() => {
  return window.Telegram.WebApp.initDataUnsafe.user || null;
});

const hasUsername = computed(() => {
  return telegramUser.value && typeof telegramUser.value.username === 'string';
});
</script>

<template>
  <div class="min-h-screen bg-background p-6">
    <div class="max-w-4xl mx-auto pt-12 space-y-8">
      <!-- Header -->
      <header class="text-center mb-12">
        <h1 class="text-5xl font-bold mb-3">
          Telegram Mini App
        </h1>
        <p class="text-muted-foreground text-lg">Welcome to the app</p>
      </header>

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

      <!-- Main App Content (only shown when username exists) -->
      <template v-else>
        <Card>
          <CardHeader>
            <div class="flex items-center justify-between">
              <CardTitle class="flex items-center gap-2">
                <span class="text-3xl">👤</span>
                User Info
              </CardTitle>
              <Badge variant="outline" class="border-emerald-400/50 text-emerald-400">
                <span class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse mr-2"></span>
                Active
              </Badge>
            </div>
          </CardHeader>
          <CardContent>
            <div class="space-y-2">
              <p class="text-sm text-muted-foreground">Username</p>
              <p class="font-mono text-lg">@{{ telegramUser?.username }}</p>
            </div>
          </CardContent>
        </Card>

        <!-- Demo Counter -->
        <Card>
          <CardHeader>
            <CardTitle class="text-center">Demo Counter</CardTitle>
          </CardHeader>
          <CardContent class="text-center space-y-4">
            <div class="text-6xl font-bold">
              {{ count }}
            </div>
            <Button @click="count++" size="lg" class="w-full sm:w-auto">
              Increment Counter
            </Button>
          </CardContent>
        </Card>
      </template>
    </div>
  </div>
</template>
