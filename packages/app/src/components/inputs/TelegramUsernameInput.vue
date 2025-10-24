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

// Get cleaned value (strip @ and whitespace) for validation and submission
// Returns null if invalid, or the cleaned username if valid
// This is what parent components should use for submission
const cleanedValue = computed((): string | null => {
  if (!props.modelValue) return null

  let cleaned = props.modelValue.trim()
  if (cleaned.startsWith('@')) {
    cleaned = cleaned.slice(1)
  }

  // If it's not valid, return null
  if (cleaned && !isValidTelegramUsername(cleaned)) return null

  return cleaned || null
})

// Validation logic
const isValid = computed(() => {
  if (!props.modelValue) return !props.required
  return cleanedValue.value !== null
})

const errorMessage = computed(() => {
  if (!props.modelValue || isValid.value) return ''
  return 'Invalid Telegram username. Must be 5-32 characters (alphanumeric and underscores only)'
})

// Expose cleanedValue and isValid for parent components to access via ref
// Exposed computed refs are automatically unwrapped by Vue
defineExpose({
  cleanedValue,
  isValid
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
        isValid && modelValue ? '!border-emerald-500 focus-visible:!ring-emerald-500' : ''
      ]"
    />
    <p v-if="errorMessage" class="text-xs text-destructive">
      {{ errorMessage }}
    </p>
  </div>
</template>
