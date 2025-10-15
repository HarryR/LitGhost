/**
 * GhostContext - Runtime context for Lit Actions
 *
 * Provides access to:
 * - Ethers v5 JSON-RPC provider
 * - LitGhost contract instance
 * - MockToken contract instance
 */

import './lit-interfaces'; // Import to ensure global type definitions are loaded
import { JsonRpcProvider, Contract, LitGhost, Token } from '@monorepo/core/sandboxed';

export class GhostContext {
  /** Ethers v5 JSON-RPC provider */
  public readonly provider: JsonRpcProvider;

  /** LitGhost contract instance */
  public readonly ghost: Contract;

  /** MockToken contract instance */
  public readonly token: Contract;

  /**
   * Create a new GhostContext
   *
   * @param rpcUrl - JSON-RPC endpoint URL
   * @param ghostAddress - LitGhost contract address
   * @param tokenAddress - MockToken contract address
   */
  constructor(
    rpcUrl: string,
    ghostAddress: string,
    tokenAddress: string
  ) {
    // Create provider
    this.provider = new JsonRpcProvider(rpcUrl);

    // Attach contract instances to addresses with provider
    this.ghost = LitGhost.connect(this.provider); //.attach(ghostAddress);
    this.token = Token.connect(this.provider); // attach(tokenAddress)
  }

  /**
   * Factory method to create context from environment variables
   *
   * @param env - Environment variables object
   * @returns GhostContext instance
   */
  static async fromEnv(env: {
    VITE_CHAIN: string;
    VITE_CONTRACT_LITGHOST: string;
    VITE_CONTRACT_TOKEN: string;
  }): Promise<GhostContext> {
    // Get RPC URL for the chain using Lit.Actions.getRpcUrl
    const rpcUrl = await Lit.Actions.getRpcUrl({ chain: env.VITE_CHAIN });

    console.log('✓ Creating GhostContext:', {
      chain: env.VITE_CHAIN,
      rpcUrl,
      ghostAddress: env.VITE_CONTRACT_LITGHOST,
      tokenAddress: env.VITE_CONTRACT_TOKEN,
    });

    return new GhostContext(
      rpcUrl,
      env.VITE_CONTRACT_LITGHOST,
      env.VITE_CONTRACT_TOKEN
    );
  }
}
