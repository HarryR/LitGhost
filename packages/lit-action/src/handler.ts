/**
 * Main request handler for Lit Action
 * Pattern matches on ghostRequest type and executes appropriate logic
 */

import './lit-interfaces'; // Import to ensure global type definitions are loaded
import { type JsParams, GhostRequestEcho, GhostRequestBootstrap } from './params';
import type { GhostContext } from './context';
import { randomBytes, arrayify, keccak256, concat } from '@monorepo/core/sandboxed';

export interface GhostResponseSuccess<T = any> {
  ok: true;
  data: T;
}

export interface GhostResponseError {
  ok: false;
  error: string;
  details?: any;
}

export type GhostResponse<T = any> = GhostResponseSuccess<T> | GhostResponseError;

/**
 * Convert base64 string to Uint8Array
 * atob() returns a "binary string" where each char represents a byte (0-255)
 * charCodeAt() extracts the numeric byte value from each character
 * This is the standard browser/Deno way to decode base64 to bytes
 */
function base64ToBytes(base64: string): Uint8Array {
  const binaryString = atob(base64.replace(/\s/g, ''));
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i) & 0xFF; // Ensure byte range
  }
  return bytes;
}

/**
 * Main request handler
 * Takes validated jsParams and context, returns a response
 * Does NOT call Lit.Actions.setResponse - that's done in main()
 *
 * @param jsParams - Validated parameters passed to the Lit Action
 * @param _ctx - Runtime context with provider and contract instances (unused for now)
 */
export async function handleRequest(
  {ghostRequest}: JsParams,
  _ctx: GhostContext
): Promise<GhostResponse> {
  try {
    switch( ghostRequest.type ) {
      case 'echo': return handleEcho(ghostRequest as GhostRequestEcho);
      case 'bootstrap': return await handleBootstrap(ghostRequest as GhostRequestBootstrap);
      default: return { ok: false, error: `Unknown request type: ${(ghostRequest as any).type}` };
    }
  } catch (error) {
    console.error('Error in handleRequest:', error);
    return {
      ok: false,
      error: error instanceof Error ? error.message : 'Unknown error',
    };
  }
}

// ============================================================================
// Individual Request Handlers
// ============================================================================

/**
 * Handle echo request - simple test that returns the message
 */
function handleEcho(request: GhostRequestEcho): GhostResponse {
  return {
    ok: true,
    data: {
      echo: request.message,
      timestamp: Date.now(),
    },
  };
}

function litCidAccessControl(cid:string) {
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

function getCurrentIPFSCid() {
  const currentCid = Lit.Auth.actionIpfsIdStack?.[0] || Lit.Auth.actionIpfsIds?.[0];
  if (!currentCid) {
    throw new Error('Could not get current action IPFS CID');
  }
  return currentCid;
}
/**
 * Handle bootstrap request - generates entropy, encrypts it, and signs it
 * This initializes the system with a secret that only this Lit Action can decrypt
 */
async function handleBootstrap(request: GhostRequestBootstrap): Promise<GhostResponse> {
  const currentCid = getCurrentIPFSCid();

  const encryptResultJson = await Lit.Actions.runOnce({waitForResponse: true, name: "generate-entropy"}, async () => {
      let encrypted = await Lit.Actions.encrypt({
        accessControlConditions: litCidAccessControl(currentCid),
        to_encrypt: randomBytes(64),
      });
      return JSON.stringify(encrypted);
  });
  const encryptResult = JSON.parse(encryptResultJson!);

  const dataHashBytes = arrayify('0x'+encryptResult.dataToEncryptHash);
  const ciphertextBytes = base64ToBytes(encryptResult.ciphertext);

  const toSign = arrayify(keccak256(concat([dataHashBytes, ciphertextBytes])));
  const signatureHex = await Lit.Actions.signAndCombineEcdsa({
    toSign,
    publicKey: request.pkpPublicKey,
    sigName: 'bootstrap-sig',
  });

  return {
    ok: true,
    data: {
      pkp: request.pkpPublicKey,
      encryptResult: encryptResult,
      sigHex: signatureHex,
    },
  }
}
