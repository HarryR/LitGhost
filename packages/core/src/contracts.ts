import { Contract } from './ethers-compat.js';
import DorpABI from "./abis/Dorp.json";
import MockTokenABI from "./abis/MockToken.json";

export const Dorp = new Contract('0x0000000000000000000000000000000000000000', DorpABI);
export const Token = new Contract('0x0000000000000000000000000000000000000000', MockTokenABI);
