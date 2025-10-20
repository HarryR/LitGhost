<script setup lang="ts">
import { ref, computed } from 'vue'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import type { IGhostClient } from '../ighostclient'

interface Props {
  ghostClient: IGhostClient | null
  privateKey: string | null
}

const props = defineProps<Props>()

// Placeholder for private balance (TODO: fetch from Lit Action)
const privateBalance = computed(() => '0.00')

// Computed property to check if we have everything needed
const isReady = computed(() => props.ghostClient && props.privateKey)
</script>

<template>
  <div class="space-y-6">
    <!-- Private Balance Card -->
    <Card v-if="isReady">
      <CardHeader>
        <div class="flex items-center justify-between">
          <CardTitle class="flex items-center gap-2">
            <span class="text-3xl">🔒</span>
            Private Balance
          </CardTitle>
          <Badge variant="outline" class="gap-1">
            <span class="w-2 h-2 bg-emerald-400 rounded-full"></span>
            Connected
          </Badge>
        </div>
      </CardHeader>
      <CardContent>
        <div class="space-y-4">
          <!-- Balance Display -->
          <div class="text-center py-6">
            <p class="text-sm text-muted-foreground mb-2">Your Private Balance</p>
            <p class="text-4xl font-bold">
              {{ privateBalance }} <span class="text-lg font-normal text-muted-foreground">PYUSD</span>
            </p>
          </div>

          <!-- Action Buttons Placeholder -->
          <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <button
              disabled
              class="px-4 py-3 rounded-md bg-muted text-muted-foreground cursor-not-allowed text-sm font-medium"
            >
              🔄 Internal Transfer
            </button>
            <button
              disabled
              class="px-4 py-3 rounded-md bg-muted text-muted-foreground cursor-not-allowed text-sm font-medium"
            >
              💸 Withdraw
            </button>
            <button
              disabled
              class="px-4 py-3 rounded-md bg-muted text-muted-foreground cursor-not-allowed text-sm font-medium"
            >
              📊 History
            </button>
          </div>

          <!-- Coming Soon Message -->
          <div class="bg-muted rounded-md p-4 text-center">
            <p class="text-sm text-muted-foreground">
              🚧 Private balance management features coming soon
            </p>
          </div>
        </div>
      </CardContent>
    </Card>

    <!-- Not Ready State -->
    <Card v-else>
      <CardHeader>
        <CardTitle class="flex items-center gap-2">
          <span class="text-3xl">🔒</span>
          Private Balance
        </CardTitle>
      </CardHeader>
      <CardContent class="text-center py-8">
        <div class="w-20 h-20 mx-auto bg-muted rounded-full flex items-center justify-center text-4xl mb-4">
          🔐
        </div>
        <p class="text-muted-foreground">
          Connect your LitGhost secret to access private balance features
        </p>
      </CardContent>
    </Card>
  </div>
</template>
