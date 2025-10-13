import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Dorp, MockToken } from "../src/contracts";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Ethers v5 imports
import { Web3Provider, JsonRpcSigner } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

import { Dorp as coreDorp, Token as coreToken } from '@monorepo/core';

/**
 * Test suite using ethers v5 to interact with deployed contracts
 *
 * This validates that code using ethers v5 (like in the core package sandbox)
 * can successfully interact with contracts deployed via hardhat's ethers v6.
 */
describe("Core Package Integration (ethers v5)", function () {
  let dorp: Dorp; // v6 typechain contract
  let token: MockToken; // v6 typechain contract
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;

  // Ethers v5 instances
  let v5Provider: Web3Provider;
  let v5Owner: JsonRpcSigner;
  let v5User1: JsonRpcSigner;
  let v5Dorp: Contract;
  let v5Token: Contract;

  const TOKEN_DECIMALS = 6;
  const INITIAL_BALANCE = ethers.parseUnits("1000000", TOKEN_DECIMALS);

  beforeEach(async function () {
    // Get ethers v6 signers for deployment
    [owner, user1] = await ethers.getSigners();

    // Deploy contracts using ethers v6
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    token = await MockTokenFactory.deploy("Mock USDC", "MUSDC", TOKEN_DECIMALS);
    await token.waitForDeployment();

    const DorpFactory = await ethers.getContractFactory("Dorp");
    dorp = await DorpFactory.deploy(await token.getAddress(), owner.address);
    await dorp.waitForDeployment();

    // Mint tokens to users
    await token.mint(user1.address, INITIAL_BALANCE);

    // Create ethers v5 provider from Hardhat's raw EIP-1193 provider
    // @ts-expect-error - Hardhat's network.provider is EIP-1193 compatible
    v5Provider = new Web3Provider(network.provider);

    // Use getSigner from the v5 provider instead of creating new Wallets
    v5Owner = v5Provider.getSigner(0);
    v5User1 = v5Provider.getSigner(1);

    // Create ethers v5 contract instances
    const dorpAddress = await dorp.getAddress();
    const tokenAddress = await token.getAddress();

    v5Dorp = coreDorp.connect(v5Owner).attach(dorpAddress);
    v5Token = coreToken.connect(v5Owner).attach(tokenAddress);
  });

  describe("Contract Initialization", function () {
    it("Should read contract state using ethers v5", async function () {
      // Call getStatus using v5 contract
      console.log('getting status');
      const status = await v5Dorp.getStatus();
      console.log('Got status');

      expect(status.counters.opCount).to.equal(0);
      expect(status.counters.processedOps).to.equal(0);
      expect(status.counters.userCount).to.equal(0);
    });

    it("Should verify signer addresses match", async function () {
      expect(await v5Owner.getAddress()).to.equal(await owner.getAddress());
      expect(await v5User1.getAddress()).to.equal(await user1.getAddress());
    });
  });

  describe("Balance Queries", function () {
    it("Should read ETH balance using ethers v5 provider", async function () {
      const balance = await v5Provider.getBalance(await v5User1.getAddress());
      expect(balance).to.be.gt(0); // Should have ETH from Hardhat default accounts
    });

    it("Should query block number", async function () {
      const blockNumber = await v5Provider.getBlockNumber();
      expect(blockNumber).to.be.gte(0);
    });
  });
});
