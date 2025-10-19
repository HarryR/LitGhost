/**
 * GhostContext - Runtime context for Lit Actions
 *
 * Provides access to:
 * - Ethers v5 JSON-RPC provider
 * - LitGhost contract instance
 * - MockToken contract instance
 */

import './lit-interfaces'; // Import to ensure global type definitions are loaded
import { JsonRpcProvider, Contract, LitGhost, Token, arrayify, keccak256, concat, verifyMessage, namespacedHmac, ManagerContext, hexlify, randomBytes } from '@monorepo/core/sandboxed';

export interface EntropySig {
  v: number;
  r: string;
  s: string;
}

export interface Entropy {
  ciphertext: string;
  digest: string;
  ipfsCid: string;
  sig: EntropySig;
  teeEncPublicKey: string;
}

interface PrivateParams {
  tgApiSecret: string
}

interface DecryptedEntropy {
  x: string;
  params: PrivateParams;
}

interface EncryptResult {
  ciphertext: string;
  dataToEncryptHash: string;
}

export class GhostContext {
  /** Ethers v5 JSON-RPC provider */
  public readonly provider: JsonRpcProvider;

  /** LitGhost contract instance */
  public readonly ghost: Contract;

  /** MockToken contract instance */
  public readonly token: Contract;

  public readonly tgBotId;
  public readonly tgPubKey;

  #privateParams: PrivateParams|null;
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
    tokenAddress: string,
    tgBotId: string,
    tgPubKey: string
  ) {
    this.#entropy = null;
    this.#privateParams = null;

    this.tgBotId = tgBotId;
    this.tgPubKey = tgPubKey;
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

  async getPrivateParams() {
    if( this.#privateParams !== null ) {
      return this.#privateParams!;
    }
    await this.entropy();
    return this.#privateParams!;
  }

  async makeEntropy(pkpEthAddress: string, tgApiSecret:string) {
    const currentCid = this.getCurrentIPFSCid();
    const accessControlConditions = this.litCidAccessControl(currentCid);
  
    const encryptResultJson = await Lit.Actions.runOnce({waitForResponse: true, name: "generate-entropy"}, async () => {
      const de:DecryptedEntropy = {
        x: hexlify(randomBytes(32)),
        params: {
          tgApiSecret,
        }
      };
      const deJson = JSON.stringify(de);
      let encryptResult = await Lit.Actions.encrypt({
        accessControlConditions,
        to_encrypt: new TextEncoder().encode(deJson),
      });
      return JSON.stringify({encryptResult, deJson});
    });
    const {deJson,encryptResult} = JSON.parse(encryptResultJson!);
  
    // Verify we can round-trip it
    const decryptedJson = await Lit.Actions.decryptAndCombine({
      accessControlConditions,
      ciphertext: encryptResult.ciphertext,
      dataToEncryptHash: encryptResult.dataToEncryptHash,
      authSig: null,
      chain: 'ethereum'
    });
    if( decryptedJson !== deJson ) {
      throw new Error("Could not decrypt entropy, round-trip fails!");
    }
    this.setEntropy(decryptedJson, pkpEthAddress);
    return encryptResult as EncryptResult;
  }
  
  getCurrentIPFSCid() {
    const currentCid = Lit.Auth.actionIpfsIdStack?.[0] || Lit.Auth.actionIpfsIds?.[0];
    if (!currentCid) {
      throw new Error('Could not get current action IPFS CID');
    }
    return currentCid;
  }

  setEntropy(decryptedJson:string, pkpEthAddress:string) {
    const de:DecryptedEntropy = JSON.parse(decryptedJson);
    if( de.x === undefined || typeof de.x !== 'string' || de.x === undefined || ! de.x.startsWith('0x') ) {
      throw new Error('Bootstrap failure, decrypted entropy x param is invalid or isnt hex!');
    }
    const decryptedBytes = new TextEncoder().encode(de.x);
    this.#privateParams = de.params;
    this.#entropy = namespacedHmac(decryptedBytes, this.getCurrentIPFSCid(), arrayify(pkpEthAddress));
    return this.#entropy;
  }

  async entropy (): Promise<Uint8Array>
  {
    if( this.#entropy !== null )
    {
      return this.#entropy;
    }
  
    // Fetch entropy from contract
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
    return this.setEntropy(decrypted, pkpEthAddress);
  }

  async getManager() {
    const e = await this.entropy();
    return new ManagerContext(e, this.ghost);
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
    VITE_TELEGRAM_BOT_ID: string;
    VITE_TELEGRAM_PUBLIC_KEY: string;
  }): Promise<GhostContext> {
    const rpcUrl = await Lit.Actions.getRpcUrl({ chain: env.VITE_CHAIN });
    return new GhostContext(
      rpcUrl,
      env.VITE_CONTRACT_LITGHOST,
      env.VITE_CONTRACT_TOKEN,
      env.VITE_TELEGRAM_BOT_ID,
      env.VITE_TELEGRAM_PUBLIC_KEY
    );
  }
}
