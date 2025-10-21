<script setup lang="ts">
import { computed } from 'vue'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { isValidTelegramUsername } from '@monorepo/core'

interface Props {
  modelValue: string
  label?: string
  required?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  label: 'Telegram Username',
  required: false,
  disabled: false,
})

defineEmits<{
  'update:modelValue': [value: string]
}>()

// Get cleaned value for validation (strip @ and whitespace)
const cleanedValue = computed(() => {
  let cleaned = props.modelValue.trim()
  if (cleaned.startsWith('@')) {
    cleaned = cleaned.slice(1)
  }
  return cleaned
})

// Validation logic - validate against cleaned value
const isValid = computed(() => {
  if (!cleanedValue.value) return !props.required
  return isValidTelegramUsername(cleanedValue.value)
})

const errorMessage = computed(() => {
  if (!cleanedValue.value || isValid.value) return ''
  return 'Invalid Telegram username. Must be 5-32 characters (alphanumeric and underscores only)'
})
</script>

<template>
  <div class="space-y-2">
    <Label :for="`username-${$attrs.id || 'input'}`" class="text-sm font-medium">
      {{ label }}
    </Label>
    <Input
      :id="`username-${$attrs.id || 'input'}`"
      :model-value="modelValue"
      @update:model-value="(value) => $emit('update:modelValue', String(value))"
      placeholder="@username"
      :disabled="disabled"
      :class="[
        'font-mono',
        errorMessage ? '!border-destructive' : '',
        isValid && cleanedValue ? '!border-emerald-500 focus-visible:!ring-emerald-500' : ''
      ]"
    />
    <p v-if="errorMessage" class="text-xs text-destructive">
      {{ errorMessage }}
    </p>
  </div>
</template>
