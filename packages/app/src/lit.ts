import { LitNodeClient } from '@lit-protocol/lit-node-client';
import { LIT_NETWORK_VALUES, LIT_ABILITY } from '@lit-protocol/constants';
import { LitActionResource, createSiweMessage, generateAuthSig } from '@lit-protocol/auth-helpers';
import { Wallet } from 'ethers';
import { SessionSigsMap } from '@lit-protocol/types';
import { GhostRequest, GhostResponse } from '@monorepo/lit-action/params';

async function getSessionSigsForAction(
  litNodeClient: LitNodeClient,
  wallet: Wallet,
  ipfsCid: string
) {
  console.log('Generating session signatures for PKP signing...');

  const sessionSigs = await litNodeClient.getSessionSigs({
    chain: 'ethereum',
    expiration: new Date(Date.now() + (1000 * 60 * 60)).toISOString(), // 1 hour
    resourceAbilityRequests: [
      {
        resource: new LitActionResource(ipfsCid),
        ability: LIT_ABILITY.LitActionExecution,
      },
      // XXX: This is weird... an empty LitAction resource ability is required!
      //      Otherwise decryption fails in the 'bootstrap' LitAction handler
      {
        resource: new LitActionResource(''),
        ability: LIT_ABILITY.LitActionExecution,
      },
    ],
    authNeededCallback: async ({ uri, expiration, resourceAbilityRequests }) => {
      const toSign = await createSiweMessage({
        uri,
        expiration,
        resources: resourceAbilityRequests,
        walletAddress: wallet.address,
        nonce: await litNodeClient.getLatestBlockhash(),
        litNodeClient,
      });
      return await generateAuthSig({
        signer: wallet,
        toSign,
      });
    },
  });

  return sessionSigs;
}

export class GhostClient {
  #network: LIT_NETWORK_VALUES;
  #debug: boolean;
  #client:LitNodeClient|null;
  #sessionSigs:SessionSigsMap|null;
  #wallet:Wallet|null;
  constructor (debug?:boolean) {
    this.#network = import.meta.env.VITE_LIT_NETWORK;
    this.#debug = debug === true;    
    this.#client = null;
    this.#sessionSigs = null
    this.#wallet = null;
  }

  async connect()
  {
    if( this.#sessionSigs === null )
    {
      const c = new LitNodeClient({
        litNetwork: this.#network,
        debug:this.#debug
      });
      await c.connect();
      console.log('Lit connected to network', this.#network);

      this.#wallet = new Wallet(import.meta.env.VITE_LIT_APP_WALLET_SECRET);
      this.#sessionSigs = await getSessionSigsForAction(c, this.#wallet, import.meta.env.VITE_GHOST_IPFSCID);
      this.#client = c;
    }
    return this.#client!;
  }

  async call(request:GhostRequest): Promise<GhostResponse> {
    // TODO: check if #sessionSigs will expire soon, if so - re-generate them
    const client = await this.connect();
    const result = await client.executeJs({
      ipfsId: import.meta.env.VITE_GHOST_IPFSCID,
      sessionSigs: this.#sessionSigs!,
      jsParams: {
        ghostRequest: request
      },
    });
    let response;
    if (typeof result.response === 'string') {
      response = JSON.parse(result.response);
    } else {
      response = result.response;
    }
    return response as GhostResponse;
  }
}