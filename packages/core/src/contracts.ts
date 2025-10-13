import { Contract } from './ethers-compat.js';
import LitGhostABI from "./abis/LitGhost.json";
import MockTokenABI from "./abis/MockToken.json";

export const LitGhost = new Contract('0x0000000000000000000000000000000000000000', LitGhostABI);
export const Token = new Contract('0x0000000000000000000000000000000000000000', MockTokenABI);
