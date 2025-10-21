<script setup lang="ts">
import { computed } from 'vue'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  modelValue: string
  label?: string
  required?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  label: 'Ethereum Address',
  required: false,
  disabled: false,
})

defineEmits<{
  'update:modelValue': [value: string]
}>()

// Validation logic
const isValid = computed(() => {
  if (!props.modelValue) return !props.required
  // Ethereum address: 0x followed by 40 hex characters
  return /^0x[a-fA-F0-9]{40}$/.test(props.modelValue)
})

const errorMessage = computed(() => {
  if (!props.modelValue || isValid.value) return ''
  return 'Invalid Ethereum address. Must be 42 characters starting with 0x'
})

</script>

<template>
  <div class="space-y-2">
    <Label :for="`address-${$attrs.id || 'input'}`" class="text-sm font-medium">
      {{ label }}
    </Label>
    <Input
      :id="`address-${$attrs.id || 'input'}`"
      :model-value="modelValue"
      @update:model-value="(value) => $emit('update:modelValue', String(value))"
      placeholder="0x..."
      :disabled="disabled"
      :class="[
        'font-mono text-xs',
        errorMessage ? '!border-destructive' : '',
        isValid && modelValue ? '!border-emerald-500 focus-visible:!ring-emerald-500' : ''
      ]"
    />
    <p v-if="errorMessage" class="text-xs text-destructive">
      {{ errorMessage }}
    </p>
  </div>
</template>
