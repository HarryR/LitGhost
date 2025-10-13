import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Dorp, MockToken } from "../src/contracts";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Ethers v5 imports
import { Web3Provider, JsonRpcSigner } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

import {
  Dorp as coreDorp,
  Token as coreToken,
  ManagerContext,
  UserClient,
  createDepositTo,
  randomKeypair,
  deriveUserKeypair,
  type InternalTransaction,
  type BalanceUpdate
} from '@monorepo/core';

/**
 * Integration test suite for Manager and User utilities
 *
 * Tests the full protocol flow:
 * - Users deposit via createDepositTo
 * - Manager processes deposits and creates encrypted updates
 * - Users watch LeafChange events and decrypt their balances
 * - Internal transfers between users
 * - Payouts to Ethereum addresses
 */
describe("Manager and User Integration (ethers v5)", function () {
  let dorp: Dorp; // v6 typechain contract
  let token: MockToken; // v6 typechain contract
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let user3: HardhatEthersSigner;

  // Ethers v5 instances
  let v5Provider: Web3Provider;
  let v5Owner: JsonRpcSigner;
  let v5Dorp: Contract;

  // Manager keys
  let teePrivateKey: Uint8Array;
  let teePublicKey: Uint8Array;
  let userMasterKey: Uint8Array;
  let manager: ManagerContext;

  const TOKEN_DECIMALS = 6;
  const INITIAL_BALANCE = ethers.parseUnits("1000000", TOKEN_DECIMALS);

  beforeEach(async function () {
    // Get ethers v6 signers for deployment
    [owner, user1, user2, user3] = await ethers.getSigners();

    // Generate manager keys
    const teeKeypair = randomKeypair();
    teePrivateKey = teeKeypair.privateKey;
    teePublicKey = teeKeypair.publicKey;

    userMasterKey = new Uint8Array(32);
    crypto.getRandomValues(userMasterKey);

    // Deploy contracts using ethers v6
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    token = await MockTokenFactory.deploy("Mock USDC", "MUSDC", TOKEN_DECIMALS);
    await token.waitForDeployment();

    const DorpFactory = await ethers.getContractFactory("Dorp");
    dorp = await DorpFactory.deploy(await token.getAddress(), owner.address);
    await dorp.waitForDeployment();

    // Mint tokens to users
    await token.mint(user1.address, INITIAL_BALANCE);
    await token.mint(user2.address, INITIAL_BALANCE);
    await token.mint(user3.address, INITIAL_BALANCE);

    // Create ethers v5 provider from Hardhat's raw EIP-1193 provider
    // @ts-expect-error - Hardhat's network.provider is EIP-1193 compatible
    v5Provider = new Web3Provider(network.provider);

    // Use getSigner from the v5 provider
    v5Owner = v5Provider.getSigner(0);

    // Create ethers v5 contract instances
    const dorpAddress = await dorp.getAddress();

    v5Dorp = coreDorp.connect(v5Owner).attach(dorpAddress);

    // Create manager context
    manager = new ManagerContext(teePrivateKey, userMasterKey, v5Dorp);
  });

  describe("Manager Utilities", function () {
    it("Should process deposit events and extract telegram usernames", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // User alice makes a deposit
      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
      await dorp.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes deposit events
      const deposits = await manager.processDepositEvents();

      expect(deposits).to.have.length(1);
      expect(deposits[0].telegramUsername).to.equal("alice");
      expect(deposits[0].amount).to.equal(100_00); // 100.00 in 2 decimals
    });

    it("Should compute encrypted user IDs correctly", async function () {
      const encryptedUserId = manager.computeEncryptedUserId("alice");
      expect(encryptedUserId).to.be.instanceOf(Uint8Array);
      expect(encryptedUserId.length).to.equal(32);

      // Same username should produce same ID (deterministic)
      const encryptedUserId2 = manager.computeEncryptedUserId("alice");
      expect(Buffer.from(encryptedUserId)).to.deep.equal(Buffer.from(encryptedUserId2));
    });

    it("Should derive user keypairs deterministically", async function () {
      const kp1 = manager.deriveUserKeypair("alice");
      const kp2 = manager.deriveUserKeypair("alice");

      expect(Buffer.from(kp1.privateKey)).to.deep.equal(Buffer.from(kp2.privateKey));
      expect(Buffer.from(kp1.publicKey)).to.deep.equal(Buffer.from(kp2.publicKey));
    });
  });

  describe("Full Protocol Flow", function () {
    it("Should handle multi-user deposits and balance queries", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Three users make deposits
      const usernames = ["alice", "bob", "charlie"];
      for (const username of usernames) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
        await dorp.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      // Manager processes deposits
      const deposits = await manager.processDepositEvents();
      expect(deposits).to.have.length(3);

      // Manager creates update batch
      const batch = await manager.createUpdateBatch(deposits, [], []);

      expect(batch.opCount).to.equal(3n);
      expect(batch.newUsers).to.have.length(3);

      // Compute transcript
      const transcript = await manager.computeTranscriptForBatch(batch);
      const transcriptHex = "0x" + Buffer.from(transcript).toString("hex");

      // Convert batch to Solidity format
      const updatesSol = batch.updates.map(leaf => ({
        encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
        idx: leaf.idx,
        nonce: leaf.nonce
      }));

      const newUsersSol = batch.newUsers.map(id => "0x" + Buffer.from(id).toString("hex"));
      const payoutsSol = batch.payouts.map(p => ({ toWho: p.toWho, amount: p.amount }));

      // Execute update via v5 contract
      await v5Dorp.doUpdate(
        batch.opStart,
        batch.opCount,
        updatesSol,
        newUsersSol,
        payoutsSol,
        transcriptHex
      );

      // Verify balances on-chain
      const aliceBalance = await manager.getBalanceFromChain("alice");
      const bobBalance = await manager.getBalanceFromChain("bob");
      const charlieBalance = await manager.getBalanceFromChain("charlie");

      expect(aliceBalance).to.equal(100_00);
      expect(bobBalance).to.equal(100_00);
      expect(charlieBalance).to.equal(100_00);
    });

    it("Should handle internal transfers between users", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice and Bob deposit
      for (const username of ["alice", "bob"]) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
        await dorp.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      // Manager processes initial deposits
      const deposits = await manager.processDepositEvents();
      const batch1 = await manager.createUpdateBatch(deposits, [], []);
      const transcript1 = await manager.computeTranscriptForBatch(batch1);

      const updatesSol1 = batch1.updates.map(leaf => ({
        encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
        idx: leaf.idx,
        nonce: leaf.nonce
      }));

      await v5Dorp.doUpdate(
        batch1.opStart,
        batch1.opCount,
        updatesSol1,
        batch1.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript1).toString("hex")
      );

      // Now Alice sends 30.00 to Bob
      const transactions: InternalTransaction[] = [
        { from: "alice", to: "bob", amount: 30_00 }
      ];

      const batch2 = await manager.createUpdateBatch([], transactions, []);
      const transcript2 = await manager.computeTranscriptForBatch(batch2);

      const updatesSol2 = batch2.updates.map(leaf => ({
        encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
        idx: leaf.idx,
        nonce: leaf.nonce
      }));

      await v5Dorp.doUpdate(
        batch2.opStart,
        batch2.opCount,
        updatesSol2,
        [],
        [],
        "0x" + Buffer.from(transcript2).toString("hex")
      );

      // Verify balances
      const aliceBalance = await manager.getBalanceFromChain("alice");
      const bobBalance = await manager.getBalanceFromChain("bob");

      expect(aliceBalance).to.equal(70_00); // 100 - 30
      expect(bobBalance).to.equal(130_00);  // 100 + 30
    });

    /*
    it("Should handle payouts to Ethereum addresses", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice deposits
      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
      await dorp.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes deposit
      const deposits = await manager.processDepositEvents();
      const batch1 = await manager.createUpdateBatch(deposits, [], []);
      const transcript1 = await manager.computeTranscriptForBatch(batch1);

      await dorp.connect(owner).doUpdate(
        batch1.opStart,
        batch1.opCount,
        batch1.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        batch1.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript1).toString("hex")
      );

      // Alice withdraws 50.00 USDC to user2's address
      const payoutAmount = ethers.parseUnits("50", TOKEN_DECIMALS);
      const payouts = [
        { telegramUsername: "alice", toAddress: user2.address, amount: payoutAmount }
      ];

      const balanceBefore = await token.balanceOf(user2.address);

      const batch2 = await manager.createUpdateBatch([], [], payouts);

      // Debug: log batch details
      console.log('batch2.updates.length:', batch2.updates.length);
      console.log('batch2.payouts.length:', batch2.payouts.length);
      if (batch2.payouts.length > 0) {
        console.log('Payout amount type:', typeof batch2.payouts[0].amount, 'value:', batch2.payouts[0].amount);
      }

      const transcript2 = await manager.computeTranscriptForBatch(batch2);

      await v5Dorp.doUpdate(
        batch2.opStart,
        batch2.opCount,
        batch2.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        [],
        batch2.payouts.map(p => ({ toWho: p.toWho, amount: p.amount.toString() })),
        "0x" + Buffer.from(transcript2).toString("hex")
      );

      // Verify payout
      const balanceAfter = await token.balanceOf(user2.address);
      expect(balanceAfter - balanceBefore).to.equal(payoutAmount);

      // Verify Alice's balance decreased
      const aliceBalance = await manager.getBalanceFromChain("alice");
      expect(aliceBalance).to.equal(50_00); // 100 - 50
    });
    */
  });  

  describe("User Client", function () {
    it("Should allow users to query their balances", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice deposits
      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
      await dorp.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes and updates
      const deposits = await manager.processDepositEvents();
      const batch = await manager.createUpdateBatch(deposits, [], []);
      const transcript = await manager.computeTranscriptForBatch(batch);

      await v5Dorp.doUpdate(
        batch.opStart,
        batch.opCount,
        batch.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        batch.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript).toString("hex")
      );

      // User client setup
      const userKeypair = deriveUserKeypair("alice", userMasterKey);
      const encryptedUserId = manager.computeEncryptedUserId("alice");

      const userClient = new UserClient(
        userKeypair.privateKey,
        encryptedUserId,
        teePublicKey,
        v5Dorp
      );

      // Query balance
      const balance = await userClient.getBalance();
      expect(balance).to.equal(100_00);
    });

    /*
    it("Should allow users to watch balance updates with async generator", async function () {
      this.timeout(10000);

      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice deposits
      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
      await dorp.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes and updates
      const deposits = await manager.processDepositEvents();
      const batch = await manager.createUpdateBatch(deposits, [], []);
      const transcript = await manager.computeTranscriptForBatch(batch);

      await v5Dorp.doUpdate(
        batch.opStart,
        batch.opCount,
        batch.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        batch.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript).toString("hex")
      );

      // User client setup
      const userKeypair = deriveUserKeypair("alice", userMasterKey);
      const encryptedUserId = manager.computeEncryptedUserId("alice");

      const userClient = new UserClient(
        userKeypair.privateKey,
        encryptedUserId,
        teePublicKey,
        v5Dorp
      );

      // Watch balance updates (historical)
      const startBlock = await v5Provider.getBlockNumber();
      const updates: BalanceUpdate[] = [];

      for await (const update of userClient.watchBalanceUpdates({
        fromBlock: startBlock - 10,
        maxEvents: 5,
        timeoutMs: 5000
      })) {
        updates.push(update);
      }

      expect(updates).to.have.length(1);
      expect(updates[0].balance).to.equal(100_00);
      expect(updates[0].nonce).to.equal(1);
    });
    */
  });
});
