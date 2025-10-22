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
  maxDecimals: 2,
  required: false,
  disabled: false,
})

defineEmits<{
  'update:modelValue': [value: string]
}>()

// Parse and clean the input value to a number (or null if invalid)
// This is what parent components should use for submission
const parsedValue = computed(() => {
  if (!props.modelValue) return null

  const num = parseFloat(props.modelValue)
  if (isNaN(num) || num <= 0) return null

  // Check decimal places - if valid, return the parsed number
  const decimalRegex = new RegExp(`^\\d+(\\.\\d{1,${props.maxDecimals}})?$`)
  if (!decimalRegex.test(props.modelValue)) return null

  return num
})

// Validation logic
const isValid = computed(() => {
  if (!props.modelValue) return !props.required

  // Must have a valid parsed value
  if (parsedValue.value === null) return false

  // Check if it exceeds balance
  if (props.balance) {
    const balanceNum = parseFloat(props.balance)
    if (parsedValue.value > balanceNum) return false
  }

  return true
})

// Expose parsedValue and isValid for parent components to access via ref
// We expose the .value to unwrap the computed refs
defineExpose({
  get parsedValue() {
    return parsedValue.value
  },
  get isValid() {
    return isValid.value
  }
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
      type="text"
      inputmode="decimal"
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
