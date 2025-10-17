/**
 * GhostContext - Runtime context for Lit Actions
 *
 * Provides access to:
 * - Ethers v5 JSON-RPC provider
 * - LitGhost contract instance
 * - MockToken contract instance
 */

import './lit-interfaces'; // Import to ensure global type definitions are loaded
import { JsonRpcProvider, Contract, LitGhost, Token, arrayify, keccak256, concat, verifyMessage, namespacedHmac } from '@monorepo/core/sandboxed';

interface EntropySig {
  v: number;
  r: string;
  s: string;
}

interface Entropy {
  ciphertext: string;
  digest: string;
  ipfsCid: string;
  sig: EntropySig;
}

export class GhostContext {
  /** Ethers v5 JSON-RPC provider */
  public readonly provider: JsonRpcProvider;

  /** LitGhost contract instance */
  public readonly ghost: Contract;

  /** MockToken contract instance */
  public readonly token: Contract;

  #entropy: Uint8Array|null;

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
    this.#entropy = null;

    this.provider = new JsonRpcProvider(rpcUrl);
    this.ghost = LitGhost.connect(this.provider).attach(ghostAddress);
    this.token = Token.connect(this.provider).attach(tokenAddress);
  }

  litCidAccessControl(cid?:string) {
    if( cid === undefined || cid === null ) {
      cid = this.getCurrentIPFSCid();
    }
    return [
      {
        contractAddress: '',
        standardContractType: '',
        chain: 'ethereum',
        method: '',
        parameters: [':currentActionIpfsId'],
        returnValueTest: {
          comparator: '=',
          value: cid,
        },
      },
    ];
  }
  
  getCurrentIPFSCid() {
    const currentCid = Lit.Auth.actionIpfsIdStack?.[0] || Lit.Auth.actionIpfsIds?.[0];
    if (!currentCid) {
      throw new Error('Could not get current action IPFS CID');
    }
    return currentCid;
  }

  async entropy (): Promise<Uint8Array>
  {
    if( this.#entropy === null )
    {
      const e = await this.ghost.getEntropy() as Entropy;

      // Recover signing address, to bind entropy to signer
      const dataHashBytes = arrayify(e.digest);
      const ciphertextBytes = new TextEncoder().encode(e.ciphertext);
      const cidBytes = new TextEncoder().encode(this.getCurrentIPFSCid());
      const digest = arrayify(keccak256(concat([dataHashBytes, ciphertextBytes, cidBytes])));
      const pkpEthAddress = verifyMessage(digest, e.sig);

      const decrypted = await Lit.Actions.decryptAndCombine({
        accessControlConditions: this.litCidAccessControl(),
        ciphertext: e.ciphertext,
        dataToEncryptHash: e.digest,
        authSig: null,
        chain: 'ethereum'
      });

      this.#entropy = namespacedHmac(decrypted, this.getCurrentIPFSCid(), arrayify(pkpEthAddress));
    }
    return this.#entropy;
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
    const rpcUrl = await Lit.Actions.getRpcUrl({ chain: env.VITE_CHAIN });
    return new GhostContext(
      rpcUrl,
      env.VITE_CONTRACT_LITGHOST,
      env.VITE_CONTRACT_TOKEN
    );
  }
}
