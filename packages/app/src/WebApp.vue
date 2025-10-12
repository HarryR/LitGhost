<script setup lang="ts">
import { ref } from 'vue'
import { useWallet } from './composables/useWallet'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Separator } from '@/components/ui/separator'

const count = ref(0)
const { address, chainId, connected, connecting, connect, disconnect, switchChain } = useWallet()

async function handleConnect() {
  await connect()
}

function handleDisconnect() {
  disconnect()
}

function handleSwitchToSepolia() {
  switchChain('0xaa36a7')
}
</script>

<template>
  <div class="min-h-screen bg-background p-6">
    <div class="max-w-4xl mx-auto pt-12 space-y-8">
      <!-- Header -->
      <header class="text-center mb-12">
        <h1 class="text-5xl font-bold mb-3">
          Web3 Portal
        </h1>
        <p class="text-muted-foreground text-lg">Connect your wallet to get started</p>
      </header>

      <!-- Wallet Card -->
      <Card>
        <CardHeader>
          <div class="flex items-center justify-between">
            <CardTitle class="flex items-center gap-2">
              <span class="text-3xl">🔐</span>
              Wallet
            </CardTitle>
            <Badge v-if="connected" variant="outline" class="border-emerald-400/50 text-emerald-400">
              <span class="w-2 h-2 bg-emerald-400 rounded-full animate-pulse mr-2"></span>
              Connected
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <!-- Not Connected State -->
          <div v-if="!connected" class="text-center py-8">
            <div class="w-20 h-20 mx-auto bg-primary/10 rounded-full flex items-center justify-center text-4xl mb-4">
              👛
            </div>
            <p class="text-muted-foreground mb-6">No wallet connected</p>
            <Button @click="handleConnect" :disabled="connecting" size="lg" class="w-full sm:w-auto">
              <span v-if="connecting">Connecting...</span>
              <span v-else>Connect Wallet</span>
            </Button>
          </div>

          <!-- Connected State -->
          <div v-else class="space-y-4">
            <div class="space-y-2">
              <p class="text-sm text-muted-foreground">Wallet Address</p>
              <p class="font-mono text-sm break-all">{{ address }}</p>
            </div>

            <Separator />

            <div class="space-y-2">
              <p class="text-sm text-muted-foreground">Network</p>
              <div class="flex items-center gap-2">
                <Badge variant="outline">Chain ID: {{ chainId }}</Badge>
              </div>
            </div>

            <Separator />

            <div class="flex flex-col sm:flex-row gap-3 pt-2">
              <Button variant="secondary" @click="handleSwitchToSepolia" class="flex-1">
                Switch to Sepolia
              </Button>
              <Button variant="destructive" @click="handleDisconnect">
                Disconnect
              </Button>
            </div>
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
    </div>
  </div>
</template>

