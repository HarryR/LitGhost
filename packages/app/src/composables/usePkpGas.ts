import { ref, computed, watch, type Ref } from 'vue';
import type { Signer } from '@ethersproject/abstract-signer';
import type { JsonRpcProvider } from '@ethersproject/providers';

export function usePkpGas(options: {
  pkpAddress: string;
  provider: Ref<JsonRpcProvider | null>;
  signer: Ref<Signer | null>;
  chainId: Ref<number | null>;
  expectedChainId: number;
}) {
  const { pkpAddress, provider, signer, chainId, expectedChainId } = options;

  const pkpBalance = ref<bigint | null>(null);
  const pkpBalanceLoading = ref(false);
  const isTopUpInProgress = ref(false);
  const gasPrice = ref<bigint>(0n);
  const userBalance = ref<bigint>(0n);

  // Constants
  const GAS_PER_TX = 200_000n; // 200k gas per transaction
  const NUM_TRANSACTIONS = 20n;

  // Fetch PKP balance
  async function fetchPkpBalance() {
    if (!provider.value) return;

    pkpBalanceLoading.value = true;
    try {
      const balance = await provider.value.getBalance(pkpAddress);
      pkpBalance.value = BigInt(balance.toString());
    } catch (error) {
      console.error('Failed to fetch PKP balance:', error);
      pkpBalance.value = null;
    } finally {
      pkpBalanceLoading.value = false;
    }
  }

  // Fetch gas price (including priority fee for realistic cost estimate)
  async function fetchGasPrice() {
    if (!provider.value) return;

    try {
      // Get the current fee data which includes base fee + priority fee
      const feeData = await provider.value.getFeeData();

      // Use maxFeePerGas if available (EIP-1559), otherwise fallback to gasPrice
      if (feeData.maxFeePerGas) {
        gasPrice.value = BigInt(feeData.maxFeePerGas.toString());
      } else if (feeData.gasPrice) {
        gasPrice.value = BigInt(feeData.gasPrice.toString());
      } else {
        // Fallback to getGasPrice
        const price = await provider.value.getGasPrice();
        gasPrice.value = BigInt(price.toString());
      }

      console.log('Gas price fetched:', gasPrice.value.toString(), 'wei');
    } catch (error) {
      console.error('Failed to fetch gas price:', error);
    }
  }

  // Fetch user balance
  async function fetchUserBalance() {
    if (!provider.value || !signer.value) return;

    try {
      const address = await signer.value.getAddress();
      const balance = await provider.value.getBalance(address);
      userBalance.value = BigInt(balance.toString());
    } catch (error) {
      console.error('Failed to fetch user balance:', error);
    }
  }

  // Watch for provider changes to fetch data
  watch(
    [provider, chainId],
    async () => {
      if (provider.value && chainId.value === expectedChainId) {
        await Promise.all([
          fetchPkpBalance(),
          fetchGasPrice(),
          fetchUserBalance(),
        ]);
      } else {
        pkpBalance.value = null;
        gasPrice.value = 0n;
        userBalance.value = 0n;
      }
    },
    { immediate: true }
  );

  // Also watch signer for user balance updates
  watch(signer, () => {
    if (provider.value && chainId.value === expectedChainId) {
      fetchUserBalance();
    }
  });

  // Cost per transaction in Wei (gas units * gas price)
  const costPerTx = computed(() => {
    if (gasPrice.value === 0n) return 0n;
    return GAS_PER_TX * gasPrice.value;
  });

  // Calculate gas requirements (20 transactions worth)
  const totalGasNeeded = computed(() => {
    if (costPerTx.value === 0n) return 0n;
    return costPerTx.value * NUM_TRANSACTIONS;
  });

  // Check if PKP needs top-up (balance < 20 tx worth of gas)
  const needsTopUp = computed(() => {
    if (pkpBalance.value === null || totalGasNeeded.value === 0n) return false;
    return pkpBalance.value < totalGasNeeded.value;
  });

  // Check if user can afford to top up
  const canAffordTopUp = computed(() => {
    if (userBalance.value === 0n || totalGasNeeded.value === 0n) return false;
    return userBalance.value >= totalGasNeeded.value;
  });

  // Number of transactions the current PKP balance can afford
  const transactionsRemaining = computed(() => {
    if (pkpBalance.value === null || costPerTx.value === 0n) return 0;
    const remaining = pkpBalance.value / costPerTx.value;
    return Number(remaining);
  });

  // Format balance for display (in ETH)
  function formatEthBalance(balance: bigint | null): string {
    if (balance === null) return '...';
    // Convert wei to ETH with 6 decimal places
    const eth = Number(balance) / 1e18;
    return eth.toFixed(6);
  }

  // Top up PKP with gas
  async function topUpGas(): Promise<{ success: boolean; txHash?: string; error?: string; cancelled?: boolean }> {
    if (!signer.value || totalGasNeeded.value === 0n) {
      return { success: false, error: 'Invalid state for top-up' };
    }

    isTopUpInProgress.value = true;
    try {
      const tx = await signer.value.sendTransaction({
        to: pkpAddress,
        value: totalGasNeeded.value.toString(),
      });

      console.log('Top-up transaction sent:', tx.hash);

      // Wait for transaction to be mined
      await tx.wait();

      console.log('Top-up transaction confirmed');

      // Refresh balances
      await Promise.all([fetchPkpBalance(), fetchUserBalance()]);

      return { success: true, txHash: tx.hash };
    } catch (error) {
      // Check if user rejected the transaction
      if (error instanceof Error) {
        // ethers v5 uses code property
        const errorCode = (error as any).code;
        if (errorCode === 'ACTION_REJECTED' || errorCode === 4001) {
          console.log('User rejected transaction');
          return { success: false, cancelled: true };
        }
      }

      console.error('Gas top-up failed:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to top up gas',
      };
    } finally {
      isTopUpInProgress.value = false;
    }
  }

  return {
    // State
    pkpBalance,
    pkpBalanceLoading,
    isTopUpInProgress,
    gasPrice,
    userBalance,

    // Computed
    totalGasNeeded,
    needsTopUp,
    canAffordTopUp,
    transactionsRemaining,

    // Methods
    fetchPkpBalance,
    formatEthBalance,
    topUpGas,

    // Constants
    GAS_PER_TX,
    NUM_TRANSACTIONS,
  };
}
