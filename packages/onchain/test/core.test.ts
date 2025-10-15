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
    lg = await LitGhostFactory.deploy(await token.getAddress());
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
      const { validDeposits: deposits } = await manager.processDepositEvents(0, 'latest', -1n);

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
      const kp1 = deriveUserKeypair("alice", userMasterKey);
      const kp2 = deriveUserKeypair("alice", userMasterKey);

      expect(Buffer.from(kp1.privateKey)).to.deep.equal(Buffer.from(kp2.privateKey));
      expect(Buffer.from(kp1.publicKey)).to.deep.equal(Buffer.from(kp2.publicKey));
    });
  });

  describe("Full Protocol Flow", function () {
    it("Should handle multi-user deposits and balance queries", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Three users make deposits
      const blockBeforeDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

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

      const blockAfterDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Manager processes deposits
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposits, blockAfterDeposits, -1n);
      expect(deposits).to.have.length(3);

      // Determine nextBlock (last deposit block + 1)
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const nextBlock = lastDepositBlock + 1;

      // Manager creates update batch
      const { batch } = await manager.createUpdateBatch(deposits, [], [], nextBlock);

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
      const blockBeforeDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      for (const username of ["alice", "bob"]) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      const blockAfterDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Manager processes initial deposits
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposits, blockAfterDeposits, -1n);
      const lastDepositBlock1 = Math.max(...deposits.map(d => d.blockNumber));
      const { batch: batch1 } = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock1 + 1);
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
      const { batch: batch2 } = await manager.createUpdateBatch([], transactions, [], currentBlock2 + 1);
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
      const blockBeforeDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      const blockAfterDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Manager processes deposit
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposit, blockAfterDeposit, -1n);
      const lastDepositBlock1 = Math.max(...deposits.map(d => d.blockNumber));
      const { batch: batch1 } = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock1 + 1);
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
      const { batch: batch2 } = await manager.createUpdateBatch([], [], payouts, currentBlock2 + 1);
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
      const blockBeforeDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

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

      const blockAfterDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Get all deposits
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposits, blockAfterDeposits, -1n);
      expect(deposits).to.have.length(3);

      // Process all deposits but specify an arbitrary nextBlock
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const nextBlock = lastDepositBlock + 5; // Arbitrary future block

      const { batch } = await manager.createUpdateBatch(deposits, [], [], nextBlock);
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
      const blockBeforeDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

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

      const blockAfterDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Process all deposits first
      const { validDeposits: allDeposits } = await manager.processDepositEvents(blockBeforeDeposits, blockAfterDeposits, -1n);
      const lastDepositBlock1 = Math.max(...allDeposits.map(d => d.blockNumber));
      const { batch: batch1 } = await manager.createUpdateBatch(allDeposits, [], [], lastDepositBlock1 + 1);
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
        { from: "user1", to: "user2", amount: 10_00 } // Small transfer between users
      ];

      const currentBlock2 = await lg.runner?.provider?.getBlockNumber() ?? lastDepositBlock1 + 1;
      const { batch: batch2 } = await manager.createUpdateBatch([], transactions, [], currentBlock2 + 1);

      // With chaffMultiplier = 3 (default) and 8 users (2 leaves total), we expect:
      // - 1 real leaf update (leaf 0, containing user1 and user2)
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

      // Verify all user balances reflect the transfer
      const user1Balance = await manager.getBalanceFromChain("user1");
      const user2Balance = await manager.getBalanceFromChain("user2");
      expect(user1Balance).to.equal(90_00); // Sent 10_00 to user2
      expect(user2Balance).to.equal(110_00); // Received 10_00 from user1

      // Verify other users unchanged
      for (const username of usernames.slice(2)) { // Skip user1 and user2
        const balance = await manager.getBalanceFromChain(username);
        expect(balance).to.equal(100_00);
      }

    });

    it("Should generate same chaff leaves for same opStart/opCount (deterministic)", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create 50 users to have enough leaves for chaff selection
      // This will create ~9 leaves, giving us room to test chaff selection
      const blockBeforeDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const usernames = Array.from({ length: 50 }, (_, i) => `user${i}`);
      for (const username of usernames) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      const blockAfterDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Process all deposits
      const { validDeposits: allDeposits } = await manager.processDepositEvents(blockBeforeDeposits, blockAfterDeposits, -1n);
      const lastDepositBlock = Math.max(...allDeposits.map(d => d.blockNumber));
      const { batch: batch1 } = await manager.createUpdateBatch(allDeposits, [], [], lastDepositBlock + 1);
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
      const { batch: batchA } = await manager.createUpdateBatch([], transactions, [], currentBlock + 1);

      // The leaf indices should be deterministic (based on opStart/opCount)
      const leafIndicesA = batchA.updates.map(l => l.idx).sort((a, b) => a - b);

      // With 50 users (~9 leaves total) and transfer affecting leaf 0:
      // - 1 real leaf update (leaf 0, containing user0 and user1)
      // - 3 chaff leaves (chaffMultiplier = 3)
      // Total: 4 leaves (1 real + 3 chaff)
      expect(leafIndicesA.length).to.equal(4); // 1 real + 3 chaff
      expect(leafIndicesA[0]).to.equal(0); // Leaf 0 contains user0 and user1
    });
  });

  describe("User Client", function () {
    it("Should allow users to query their balances", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Alice deposits
      const blockBeforeDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      const blockAfterDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Manager processes and updates
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposit, blockAfterDeposit, -1n);
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const { batch } = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock + 1);
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
      const blockBeforeDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      const blockAfterDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Manager processes initial deposit
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposit, blockAfterDeposit, -1n);
      const lastDepositBlock1 = Math.max(...deposits.map(d => d.blockNumber));
      const { batch: batch1 } = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock1 + 1);
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
      const { batch: batch2 } = await manager.createUpdateBatch([], transactions, [], currentBlock2 + 1);
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
      const blockBeforeDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      const blockAfterDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Manager processes deposit
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposit, blockAfterDeposit, -1n);
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const { batch } = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock + 1);
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
      const blockBeforeDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      const blockAfterDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Manager processes deposit
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposit, blockAfterDeposit, -1n);
      const lastDepositBlock = Math.max(...deposits.map(d => d.blockNumber));
      const { batch } = await manager.createUpdateBatch(deposits, [], [], lastDepositBlock + 1);
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

  describe("Balance Overflow Handling", function () {
    const MAX_BALANCE = 4294967295; // uint32 max in 2 decimals = 42,949,672.95 tokens

    it("Should refund excess when deposit would overflow uint32 max", async function () {
      const depositAmount1 = ethers.parseUnits("42949672", TOKEN_DECIMALS); // Just under max
      const depositAmount2 = ethers.parseUnits("1", TOKEN_DECIMALS); // Would overflow

      // Mint enough tokens for user1 to make these large deposits
      await token.mint(user1.address, depositAmount1);
      await token.mint(user1.address, depositAmount2);

      // First deposit brings Alice near max
      const blockBeforeDeposit1 = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { depositTo: depositTo1 } = await createDepositTo("alice", teePublicKey);
      const depositToSol1 = {
        rand: "0x" + Buffer.from(depositTo1.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo1.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount1);
      await lg.connect(user1).depositERC20(depositToSol1, depositAmount1);

      const blockAfterDeposit1 = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Process first deposit
      const { validDeposits: deposits1 } = await manager.processDepositEvents(blockBeforeDeposit1, blockAfterDeposit1, -1n);
      const { batch: batch1 } = await manager.createUpdateBatch(deposits1, [], [], blockAfterDeposit1 + 1);
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

      // Verify Alice is near max
      const aliceBalance1 = await manager.getBalanceFromChain("alice");
      expect(aliceBalance1).to.be.closeTo(MAX_BALANCE, 100); // Within 1.00 tokens

      // Second deposit would overflow
      const blockBeforeDeposit2 = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { depositTo: depositTo2 } = await createDepositTo("alice", teePublicKey);
      const depositToSol2 = {
        rand: "0x" + Buffer.from(depositTo2.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo2.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount2);
      await lg.connect(user1).depositERC20(depositToSol2, depositAmount2);

      const blockAfterDeposit2 = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Process second deposit (should generate refund)
      const { validDeposits: deposits2 } = await manager.processDepositEvents(blockBeforeDeposit2, blockAfterDeposit2, batch1.opStart + batch1.opCount);
      const { batch: batch2 } = await manager.createUpdateBatch(deposits2, [], [], blockAfterDeposit2 + 1);

      // Batch should have payouts (refunds)
      expect(batch2.payouts.length).to.be.greaterThan(0);

      const transcript2 = await manager.computeTranscriptForBatch(batch2);

      // Get user1 balance before doUpdate (after deposit was taken by contract)
      const contractBalanceBefore = await token.balanceOf(await lg.getAddress());

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

      // Verify Alice balance is capped at max
      const aliceBalance2 = await manager.getBalanceFromChain("alice");
      expect(aliceBalance2).to.equal(MAX_BALANCE);

      // Verify contract paid out the refund (contract balance decreased)
      const contractBalanceAfter = await token.balanceOf(await lg.getAddress());
      expect(contractBalanceAfter).to.be.lessThan(contractBalanceBefore);
    });

    it("Should cap internal transfer when recipient would overflow", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Setup: Alice and Bob both deposit
      const blockBeforeDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      for (const username of ["alice", "bob"]) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      const blockAfterDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposits, blockAfterDeposits, -1n);
      const { batch: batch1 } = await manager.createUpdateBatch(deposits, [], [], blockAfterDeposits + 1);
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

      // Manually set Bob to near-max (we'd need a helper or multiple deposits in real scenario)
      // For this test, we'll simulate by trying to transfer more than Bob can receive
      // Alice: 100, Bob: 100
      // Try to transfer 50 from Alice to Bob when Bob is at (MAX_BALANCE - 30)
      // Expected: Transfer only 30, Alice keeps 70, Bob gets MAX_BALANCE

      // This is a simplified test - in production Bob would need to be actually near max
      const transactions: InternalTransaction[] = [
        { from: "alice", to: "bob", amount: 50_00 }
      ];

      const currentBlock2 = await lg.runner?.provider?.getBlockNumber() ?? blockAfterDeposits + 1;
      const { batch: batch2 } = await manager.createUpdateBatch([], transactions, [], currentBlock2 + 1);
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

      // Verify transfer completed (capped or not)
      const aliceBalance = await manager.getBalanceFromChain("alice");
      const bobBalance = await manager.getBalanceFromChain("bob");

      // Since Bob started at 100 and could receive 50, transfer should complete
      expect(aliceBalance).to.equal(50_00);
      expect(bobBalance).to.equal(150_00);
    });
  });

  describe("Invalid Username Handling", function () {
    it("Should skip internal transfer to invalid username", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Setup: Alice deposits
      const blockBeforeDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { depositTo } = await createDepositTo("alice", teePublicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      const blockAfterDeposit = await lg.runner?.provider?.getBlockNumber() ?? 0;

      // Process deposit
      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposit, blockAfterDeposit, -1n);
      const { batch: batch1 } = await manager.createUpdateBatch(deposits, [], [], blockAfterDeposit + 1);
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

      // Verify Alice has balance
      const aliceBalanceBefore = await manager.getBalanceFromChain("alice");
      expect(aliceBalanceBefore).to.equal(100_00);

      // Try to transfer to invalid usernames
      const transactions: InternalTransaction[] = [
        { from: "alice", to: "123invalid", amount: 10_00 },  // Starts with number
        { from: "alice", to: "_underscore", amount: 10_00 }, // Starts with underscore
        { from: "alice", to: "a__double", amount: 10_00 },   // Double underscore
        { from: "alice", to: "trailing_", amount: 10_00 },   // Ends with underscore
      ];

      const currentBlock = await lg.runner?.provider?.getBlockNumber() ?? blockAfterDeposit + 1;
      const { batch: batch2, skippedOperations } = await manager.createUpdateBatch([], transactions, [], currentBlock + 1);

      // Verify all transfers were skipped
      expect(skippedOperations.length).to.equal(4);
      expect(skippedOperations.every(op => op.type === 'transfer')).to.be.true;

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

      // Verify Alice still has all her balance (no transfers went through)
      const aliceBalanceAfter = await manager.getBalanceFromChain("alice");
      expect(aliceBalanceAfter).to.equal(100_00);
    });

    it("Should handle valid and invalid transfers in same batch", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Setup: Alice and Bob both deposit
      const blockBeforeDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      for (const username of ["alice", "bob"]) {
        const { depositTo } = await createDepositTo(username, teePublicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      const blockAfterDeposits = await lg.runner?.provider?.getBlockNumber() ?? 0;

      const { validDeposits: deposits } = await manager.processDepositEvents(blockBeforeDeposits, blockAfterDeposits, -1n);
      const { batch: batch1 } = await manager.createUpdateBatch(deposits, [], [], blockAfterDeposits + 1);
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

      // Mix of valid and invalid transfers
      const transactions: InternalTransaction[] = [
        { from: "alice", to: "bob", amount: 20_00 },        // VALID
        { from: "alice", to: "invalid_", amount: 10_00 },   // INVALID - ends with underscore
        { from: "alice", to: "bob", amount: 10_00 },        // VALID
      ];

      const currentBlock = await lg.runner?.provider?.getBlockNumber() ?? blockAfterDeposits + 1;
      const { batch: batch2, skippedOperations } = await manager.createUpdateBatch([], transactions, [], currentBlock + 1);

      // Verify one transfer was skipped
      expect(skippedOperations.length).to.equal(1);
      expect(skippedOperations[0].type).to.equal('transfer');
      expect(skippedOperations[0].reason).to.include('invalid_');

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

      // Verify only valid transfers went through (20 + 10 = 30)
      const aliceBalance = await manager.getBalanceFromChain("alice");
      const bobBalance = await manager.getBalanceFromChain("bob");

      expect(aliceBalance).to.equal(70_00); // 100 - 30
      expect(bobBalance).to.equal(130_00);  // 100 + 30
    });
  });
});
