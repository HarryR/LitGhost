<script setup lang="ts">
import { computed } from 'vue'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

interface Props {
  modelValue: string
  label?: string
  balance?: string | null
  tokenSymbol?: string
  maxDecimals?: number
  required?: boolean
  disabled?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  label: 'Amount',
  tokenSymbol: 'PYUSD',
  maxDecimals: 6,
  required: false,
  disabled: false,
})

defineEmits<{
  'update:modelValue': [value: string]
}>()

// Validation logic
const isValid = computed(() => {
  if (!props.modelValue) return !props.required

  const num = parseFloat(props.modelValue)

  // Check if it's a valid number
  if (isNaN(num)) return false

  // Check if it's positive
  if (num <= 0) return false

  // Check decimal places
  const decimalRegex = new RegExp(`^\\d+(\\.\\d{1,${props.maxDecimals}})?$`)
  if (!decimalRegex.test(props.modelValue)) return false

  // Check if it exceeds balance
  if (props.balance) {
    const balanceNum = parseFloat(props.balance)
    if (num > balanceNum) return false
  }

  return true
})

const errorMessage = computed(() => {
  if (!props.modelValue || isValid.value) return ''

  const num = parseFloat(props.modelValue)

  if (isNaN(num) || num <= 0) {
    return 'Amount must be greater than 0'
  }

  const decimalRegex = new RegExp(`^\\d+(\\.\\d{1,${props.maxDecimals}})?$`)
  if (!decimalRegex.test(props.modelValue)) {
    return `Enter a valid amount with up to ${props.maxDecimals} decimal places`
  }

  if (props.balance) {
    const balanceNum = parseFloat(props.balance)
    if (num > balanceNum) {
      return `Insufficient balance. Available: ${props.balance} ${props.tokenSymbol}`
    }
  }

  return 'Invalid amount'
})
</script>

<template>
  <div class="space-y-2">
    <Label :for="`amount-${$attrs.id || 'input'}`" class="text-sm font-medium">
      {{ label }}
      <span v-if="balance" class="text-muted-foreground font-normal">
        (Available: {{ balance }} {{ tokenSymbol }})
      </span>
    </Label>
    <Input
      :id="`amount-${$attrs.id || 'input'}`"
      :model-value="modelValue"
      @update:model-value="(value) => $emit('update:modelValue', String(value))"
      type="number"
      step="0.01"
      min="0"
      placeholder="0.00"
      :disabled="disabled"
      :class="[
        errorMessage ? '!border-destructive' : '',
        isValid && modelValue ? '!border-emerald-500 focus-visible:!ring-emerald-500' : ''
      ]"
    />
    <p v-if="errorMessage" class="text-xs text-destructive">
      {{ errorMessage }}
    </p>
  </div>
</template>
