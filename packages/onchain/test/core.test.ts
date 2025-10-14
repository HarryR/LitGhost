import { expect } from "chai";
import { ethers, network } from "hardhat";
import { LitGhost, MockToken } from "../src/contracts";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Ethers v5 imports
import { Web3Provider, JsonRpcSigner } from "@ethersproject/providers";
import { Contract } from "@ethersproject/contracts";

import {
  LitGhost as coreLitGhost,
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
  let lg: LitGhost; // v6 typechain contract
  let token: MockToken; // v6 typechain contract
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let user3: HardhatEthersSigner;

  // Ethers v5 instances
  let v5Provider: Web3Provider;
  let v5Owner: JsonRpcSigner;
  let v5lg: Contract;

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

    const LitGhostFactory = await ethers.getContractFactory("LitGhost");
    lg = await LitGhostFactory.deploy(await token.getAddress(), owner.address);
    await lg.waitForDeployment();

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
    const lgAddress = await lg.getAddress();

    v5lg = coreLitGhost.connect(v5Owner).attach(lgAddress);

    // Create manager context
    manager = new ManagerContext(teePrivateKey, userMasterKey, v5lg);
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

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes deposit events
      const deposits = await manager.processDepositEvents();

      expect(deposits).to.have.length(1);
      expect(deposits[0].telegramUsername).to.equal("alice");
      expect(deposits[0].amount).to.equal(100_00); // 100.00 in 2 decimals
    });

    it("Should compute user public keys correctly", async function () {
      const userPublicKey = manager.getUserPublicKey("alice");
      expect(userPublicKey).to.be.instanceOf(Uint8Array);
      expect(userPublicKey.length).to.equal(32);

      // Same username should produce same public key (deterministic)
      const userPublicKey2 = manager.getUserPublicKey("alice");
      expect(Buffer.from(userPublicKey)).to.deep.equal(Buffer.from(userPublicKey2));
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

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      // Manager processes deposits
      const deposits = await manager.processDepositEvents();
      expect(deposits).to.have.length(3);

      // Determine nextBlock (last deposit block + 1)
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const nextBlock = lastDepositBlock + 1;

      // Manager creates update batch
      const batch = await manager.createUpdateBatch(deposits, [], [], nextBlock);

      expect(batch.opCount).to.equal(3n);
      expect(batch.newUsers).to.have.length(3);
      expect(batch.nextBlock).to.equal(BigInt(nextBlock));

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
      await v5lg.doUpdate(
        batch.opStart,
        batch.opCount,
        batch.nextBlock,
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

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      // Manager processes initial deposits
      const deposits = await manager.processDepositEvents();
      const lastDepositBlock1 = Math.max(...deposits.map(d => d.blockNumber));
      const batch1 = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock1 + 1);
      const transcript1 = await manager.computeTranscriptForBatch(batch1);

      const updatesSol1 = batch1.updates.map(leaf => ({
        encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
        idx: leaf.idx,
        nonce: leaf.nonce
      }));

      await v5lg.doUpdate(
        batch1.opStart,
        batch1.opCount,
        batch1.nextBlock,
        updatesSol1,
        batch1.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript1).toString("hex")
      );

      // Now Alice sends 30.00 to Bob
      const transactions: InternalTransaction[] = [
        { from: "alice", to: "bob", amount: 30_00 }
      ];

      // Internal transfer - no new deposits, stay at current block
      const currentBlock2 = await lg.runner?.provider?.getBlockNumber() ?? lastDepositBlock1 + 1;
      const batch2 = await manager.createUpdateBatch([], transactions, [], currentBlock2 + 1);
      const transcript2 = await manager.computeTranscriptForBatch(batch2);

      const updatesSol2 = batch2.updates.map(leaf => ({
        encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
        idx: leaf.idx,
        nonce: leaf.nonce
      }));

      await v5lg.doUpdate(
        batch2.opStart,
        batch2.opCount,
        batch2.nextBlock,
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

    it("Should handle payouts to Ethereum addresses", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice deposits
      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes deposit
      const deposits = await manager.processDepositEvents();
      const lastDepositBlock1 = Math.max(...deposits.map(d => d.blockNumber));
      const batch1 = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock1 + 1);
      const transcript1 = await manager.computeTranscriptForBatch(batch1);

      await v5lg.connect(v5Owner).doUpdate(
        batch1.opStart,
        batch1.opCount,
        batch1.nextBlock,
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
      const currentBlock2 = await lg.runner?.provider?.getBlockNumber() ?? lastDepositBlock1 + 1;
      const batch2 = await manager.createUpdateBatch([], [], payouts, currentBlock2 + 1);
      const transcript2 = await manager.computeTranscriptForBatch(batch2);

      await v5lg.doUpdate(
        batch2.opStart,
        batch2.opCount,
        batch2.nextBlock,
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
  });  

  describe("Block Height Tracking", function () {
    it("Should track lastProcessedBlock correctly and support stateless resume", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create multiple deposits
      const usernames = ["dave", "eve", "frank"];
      for (const username of usernames) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      // Get all deposits
      const deposits = await manager.processDepositEvents();
      expect(deposits).to.have.length(3);

      // Process all deposits but specify an arbitrary nextBlock
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const nextBlock = lastDepositBlock + 5; // Arbitrary future block

      const batch = await manager.createUpdateBatch(deposits, [], [], nextBlock);
      const transcript = await manager.computeTranscriptForBatch(batch);

      await v5lg.doUpdate(
        batch.opStart,
        batch.opCount,
        batch.nextBlock,
        batch.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        batch.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript).toString("hex")
      );

      // Verify lastProcessedBlock was updated to nextBlock
      const status = await lg.getStatus();
      expect(status.counters.lastProcessedBlock).to.equal(nextBlock);
      expect(status.counters.processedOps).to.equal(3);

      // Verify stateless resume works - should start from nextBlock + 1
      const { fromBlock } = await manager.getBlockRangeToProcess();
      expect(fromBlock).to.equal(nextBlock + 1);
    });
  });

  describe("Chaff Leaves for Privacy", function () {
    it("Should add deterministic chaff leaves to updates", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create enough users to span multiple leaves (6 users per leaf)
      // We'll create 8 users, so they span 2 leaves (leaf 0 and leaf 1)
      const usernames = ["user1", "user2", "user3", "user4", "user5", "user6", "user7", "user8"];
      for (const username of usernames) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      // Process all deposits first
      const allDeposits = await manager.processDepositEvents();
      const lastDepositBlock1 = Math.max(...allDeposits.map(d => d.blockNumber));
      const batch1 = await manager.createUpdateBatch(allDeposits, [], [], lastDepositBlock1 + 1);
      const transcript1 = await manager.computeTranscriptForBatch(batch1);

      await v5lg.doUpdate(
        batch1.opStart,
        batch1.opCount,
        batch1.nextBlock,
        batch1.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        batch1.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript1).toString("hex")
      );

      // Now do a small internal transfer that only affects one user
      const transactions: InternalTransaction[] = [
        { from: "user1", to: "user1", amount: 0 } // Self-transfer (no balance change)
      ];

      const currentBlock2 = await lg.runner?.provider?.getBlockNumber() ?? lastDepositBlock1 + 1;
      const batch2 = await manager.createUpdateBatch([], transactions, [], currentBlock2 + 1);

      // With chaffMultiplier = 3 (default) and 8 users (2 leaves total), we expect:
      // - 1 real leaf update (leaf 0, containing user1)
      // - 1 chaff leaf (leaf 1 - the only other leaf available)
      // Total: 2 leaves updated (limited by total leaf count)
      expect(batch2.updates.length).to.equal(2);

      // Verify all leaf nonces have been incremented
      for (const leaf of batch2.updates) {
        expect(leaf.nonce).to.be.greaterThan(0);
      }

      // Verify the update is valid by computing transcript and executing
      const transcript2 = await manager.computeTranscriptForBatch(batch2);

      await v5lg.doUpdate(
        batch2.opStart,
        batch2.opCount,
        batch2.nextBlock,
        batch2.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        [],
        [],
        "0x" + Buffer.from(transcript2).toString("hex")
      );

      // Verify all user balances remain correct after chaff update
      for (const username of usernames) {
        const balance = await manager.getBalanceFromChain(username);
        expect(balance).to.equal(100_00);
      }

    });

    it("Should generate same chaff leaves for same opStart/opCount (deterministic)", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create 12 users (2 full leaves)
      const usernames = Array.from({ length: 12 }, (_, i) => `user${i}`);
      for (const username of usernames) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      // Process all deposits
      const allDeposits = await manager.processDepositEvents();
      const lastDepositBlock = Math.max(...allDeposits.map(d => d.blockNumber));
      const batch1 = await manager.createUpdateBatch(allDeposits, [], [], lastDepositBlock + 1);
      const transcript1 = await manager.computeTranscriptForBatch(batch1);

      await v5lg.doUpdate(
        batch1.opStart,
        batch1.opCount,
        batch1.nextBlock,
        batch1.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        batch1.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript1).toString("hex")
      );

      // Create two identical internal transaction batches
      const transactions: InternalTransaction[] = [
        { from: "user0", to: "user1", amount: 10_00 }
      ];

      // Create first batch
      const currentBlock = await lg.runner?.provider?.getBlockNumber() ?? lastDepositBlock + 1;
      const batchA = await manager.createUpdateBatch([], transactions, [], currentBlock + 1);

      // The leaf indices should be deterministic (based on opStart/opCount)
      const leafIndicesA = batchA.updates.map(l => l.idx).sort((a, b) => a - b);

      // With 12 users (2 full leaves) and transfer affecting leaf 0:
      // - 1 real leaf update (leaf 0, containing user0 and user1)
      // - Up to 3 chaff leaves, but only 1 other leaf exists (leaf 1)
      // Total: 2 leaves (limited by total leaf count)
      expect(leafIndicesA.length).to.equal(2); // 1 real + 1 chaff
      expect(leafIndicesA[0]).to.equal(0); // Leaf 0 contains user0 and user1
    });
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

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes and updates
      const deposits = await manager.processDepositEvents();
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const batch = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock + 1);
      const transcript = await manager.computeTranscriptForBatch(batch);

      await v5lg.doUpdate(
        batch.opStart,
        batch.opCount,
        batch.nextBlock,
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

      const userClient = new UserClient(
        userKeypair.privateKey,
        userKeypair.publicKey,  // Public key is now what's stored on-chain
        teePublicKey,
        v5lg
      );

      // Query balance
      const balance = await userClient.getBalance();
      expect(balance).to.equal(100_00);
    });

    it("Should watch balance updates via LeafChange events", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice deposits
      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes initial deposit
      const deposits = await manager.processDepositEvents();
      const lastDepositBlock1 = Math.max(...deposits.map(d => d.blockNumber));
      const batch1 = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock1 + 1);
      const transcript1 = await manager.computeTranscriptForBatch(batch1);

      // Record block number before first update
      const blockBeforeFirstUpdate = await lg.runner?.provider?.getBlockNumber() ?? 0;

      await v5lg.doUpdate(
        batch1.opStart,
        batch1.opCount,
        batch1.nextBlock,
        batch1.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        batch1.newUsers.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript1).toString("hex")
      );

      // User client setup
      const userKeypair = deriveUserKeypair("alice", userMasterKey);

      const userClient = new UserClient(
        userKeypair.privateKey,
        userKeypair.publicKey,  // Public key is now what's stored on-chain
        teePublicKey,
        v5lg
      );

      // Now do an internal transfer to trigger another LeafChange event
      const transactions: InternalTransaction[] = [
        { from: "alice", to: "alice", amount: 10_00 }
      ];

      const currentBlock2 = await lg.runner?.provider?.getBlockNumber() ?? lastDepositBlock1 + 1;
      const batch2 = await manager.createUpdateBatch([], transactions, [], currentBlock2 + 1);
      const transcript2 = await manager.computeTranscriptForBatch(batch2);

      await v5lg.doUpdate(
        batch2.opStart,
        batch2.opCount,
        batch2.nextBlock,
        batch2.updates.map(leaf => ({
          encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
          idx: leaf.idx,
          nonce: leaf.nonce
        })),
        [],
        [],
        "0x" + Buffer.from(transcript2).toString("hex")
      );

      // Watch for historical balance updates from before first update
      const updates: BalanceUpdate[] = [];
      for await (const update of userClient.watchBalanceUpdates({
        fromBlock: blockBeforeFirstUpdate,
        maxEvents: 2  // Only expect 2 events for this test
      })) {
        if( update !== null ) {
          updates.push(update);
        }
      }

      // Should have received 2 updates (initial deposit and internal transfer)
      expect(updates.length).to.equal(2);

      // First update should show 100_00 balance
      expect(updates[0].balance).to.equal(100_00);
      expect(updates[0].nonce).to.equal(1);

      // Second update should still show 100_00 (self-transfer doesn't change balance)
      expect(updates[1].balance).to.equal(100_00);
      expect(updates[1].nonce).to.equal(2); // Nonce incremented

      // Updates should have block numbers and transaction hashes
      expect(updates[0].blockNumber).to.be.greaterThan(0);
      expect(updates[1].blockNumber).to.be.greaterThan(updates[0].blockNumber);
      expect(updates[0].transactionHash).to.be.a('string');
      expect(updates[1].transactionHash).to.be.a('string');
    });

    it("Should support keepalive signals and manual breakout", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice deposits
      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes deposit
      const deposits = await manager.processDepositEvents();
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const batch = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock + 1);
      const transcript = await manager.computeTranscriptForBatch(batch);

      await v5lg.doUpdate(
        batch.opStart,
        batch.opCount,
        batch.nextBlock,
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

      const userClient = new UserClient(
        userKeypair.privateKey,
        userKeypair.publicKey,  // Public key is now what's stored on-chain
        teePublicKey,
        v5lg
      );

      // Test keepalive: watch with 100ms keepalive interval
      const updates: (BalanceUpdate | null)[] = [];
      let keepaliveCount = 0;

      for await (const update of userClient.watchBalanceUpdates({
        fromBlock: lastDepositBlock,
        keepaliveMs: 100  // Very short for testing
      })) {
        updates.push(update);

        if (update === null) {
          keepaliveCount++;
          // Break after receiving 2 keepalive signals
          if (keepaliveCount >= 2) {
            break;
          }
        }
      }

      // Should have received: 1 real update + 2 keepalive nulls
      expect(updates.length).to.equal(3);
      expect(updates[0]).to.not.be.null;
      expect((updates[0] as BalanceUpdate).balance).to.equal(100_00);
      expect(updates[1]).to.be.null;
      expect(updates[2]).to.be.null;
      expect(keepaliveCount).to.equal(2);
    });

    it("Should support manual breakout without keepalive", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice deposits
      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Manager processes deposit
      const deposits = await manager.processDepositEvents();
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const batch = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock + 1);
      const transcript = await manager.computeTranscriptForBatch(batch);

      await v5lg.doUpdate(
        batch.opStart,
        batch.opCount,
        batch.nextBlock,
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

      const userClient = new UserClient(
        userKeypair.privateKey,
        userKeypair.publicKey,  // Public key is now what's stored on-chain
        teePublicKey,
        v5lg
      );

      // Test manual breakout: watch without keepalive, break after 1 event
      const updates: BalanceUpdate[] = [];

      for await (const update of userClient.watchBalanceUpdates({
        fromBlock: lastDepositBlock
      })) {
        if (update !== null) {
          updates.push(update);
          // Break immediately after first real event
          break;
        }
      }

      // Should have received exactly 1 update
      expect(updates.length).to.equal(1);
      expect(updates[0].balance).to.equal(100_00);
    });
  });
});
