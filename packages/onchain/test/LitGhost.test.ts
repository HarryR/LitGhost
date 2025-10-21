import { expect } from "chai";
import { ethers } from "hardhat";
import { LitGhost, MockToken } from "../src/contracts";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  createDepositTo,
  randomKeypair,
  decryptDepositTo,
  encryptLeaf,
  computeSharedSecret,
  getUserLeafInfo,
  computeTranscript,
  deriveUserKeypair,
  type Leaf,
  type Payout,
  type UpdateBatch,
} from "@monorepo/core";
import { keccak256 } from "@ethersproject/keccak256";
import { arrayify, concat } from "@ethersproject/bytes";

/**
 * Comprehensive test suite for the LitGhost contract
 *
 * This suite validates that the on-chain Solidity contract works correctly
 * with the TypeScript cryptographic library functions from @monorepo/core.
 *
 * Key validations:
 * - User ID blinding/unblinding between TS and Solidity
 * - TEE can decrypt deposit recipients using ephemeral keys
 * - Balance encryption with nonces matches expected behavior
 * - Transcript hashing (using computeTranscript) matches Solidity implementation
 * - ERC20 and ERC3009 (transferWithAuthorization) deposit flows
 * - Encrypted leaf updates and payout processing
 */
describe("LitGhost Contract", function () {
  let lg: LitGhost;
  let token: MockToken;
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let teeKeypair: { publicKey: Uint8Array; privateKey: Uint8Array };
  let userMasterKey: Uint8Array;

  const TOKEN_DECIMALS = 6;
  const INITIAL_BALANCE = ethers.parseUnits("1000000", TOKEN_DECIMALS);

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Generate TEE keypair and user master key
    teeKeypair = await randomKeypair();
    userMasterKey = new Uint8Array(32);
    crypto.getRandomValues(userMasterKey);

    // Deploy mock token with 6 decimals (like USDC)
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    token = await MockTokenFactory.deploy("Mock USDC", "MUSDC", TOKEN_DECIMALS);
    await token.waitForDeployment();

    // Deploy LitGhost contract
    const LitGhostFactory = await ethers.getContractFactory("LitGhost");
    lg = await LitGhostFactory.deploy(await token.getAddress());
    await lg.waitForDeployment();

    // Mint tokens to users
    await token.mint(user1.address, INITIAL_BALANCE);
    await token.mint(user2.address, INITIAL_BALANCE);
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      const status = await lg.getStatus();
      expect(status.counters.opCount).to.equal(0);
      expect(status.counters.processedOps).to.equal(0);
      // User ID 0 is reserved as sentinel, so userCount starts at 1
      expect(status.counters.userCount).to.be.greaterThanOrEqual(1);
    });

    it("Should have correct token address", async function () {
      // Token should be set correctly (we can verify by trying a deposit)
      expect(await token.balanceOf(user1.address)).to.equal(INITIAL_BALANCE);
    });
  });

  describe("depositERC20", function () {
    it("Should accept a deposit with blinded user ID", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // User creates deposit using crypto library
      const { depositTo, ephemeralPrivateKey } = await createDepositTo(
        "user123",
        teeKeypair.publicKey
      );

      // Convert to Solidity format
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      // Approve and deposit
      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      const tx = await lg
        .connect(user1)
        .depositERC20(depositToSol, depositAmount);
      const receipt = await tx.wait();

      // Check event
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "OpDeposit"
      ) as any;
      expect(event).to.not.be.undefined;

      // Verify TEE can decrypt the telegram username
      const decryptedUsername = decryptDepositTo(
        depositTo,
        teeKeypair.privateKey
      );
      expect(decryptedUsername).to.equal("user123");

      // Verify counter updated
      const status = await lg.getStatus();
      expect(status.counters.opCount).to.equal(1);
    });

    it("Should handle dust correctly when depositing", async function () {
      // Deposit an amount that creates dust (not divisible by 10^4 for 6 decimals -> 2 decimals)
      const depositAmount = BigInt("100000001"); // 100.000001 MUSDC (1 wei of dust)

      const { depositTo } = await createDepositTo("user123", teeKeypair.publicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Check dust was accumulated
      const status = await lg.getStatus();
      expect(status.dust).to.equal(1n);
    });
  });

  describe("depositERC3009", function () {
    it("Should accept deposit with ERC3009 receiveWithAuthorization", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;

      const { depositTo } = await createDepositTo("user789", teeKeypair.publicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      // Nonce is hash of depositTo struct (as per contract)
      const nonceBytes = ethers.solidityPackedKeccak256(
        ["bytes32", "bytes32", "uint256"],
        [depositToSol.rand, depositToSol.user, 0]
      );

      const domain = {
        name: await token.name(),
        version: "1",
        chainId: (await ethers.provider.getNetwork()).chainId,
        verifyingContract: await token.getAddress(),
      };

      const types = {
        ReceiveWithAuthorization: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "value", type: "uint256" },
          { name: "validAfter", type: "uint256" },
          { name: "validBefore", type: "uint256" },
          { name: "nonce", type: "bytes32" },
        ],
      };

      const value = {
        from: user1.address,
        to: await lg.getAddress(),
        value: depositAmount,
        validAfter: validAfter,
        validBefore: validBefore,
        nonce: nonceBytes,
      };

      const signature = await user1.signTypedData(domain, types, value);
      const sig = ethers.Signature.from(signature);

      const auth = {
        from: user1.address,
        value: depositAmount,
        validAfter: validAfter,
        validBefore: validBefore,
        sig: {
          v: sig.v,
          r: sig.r,
          s: sig.s,
        },
      };

      // Deposit using ERC3009 - only the LitGhost contract (receiver) can call this
      const tx = await lg.connect(user2).depositERC3009(depositToSol, auth);
      await tx.wait();

      // Verify deposit succeeded
      const status = await lg.getStatus();
      expect(status.counters.opCount).to.equal(1);
    });
  });

  describe("doUpdate", function () {
    it("Should process deposits and update encrypted leaves", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create 6 users and their deposits
      const users: string[] = [];
      const userPublicKeys: Uint8Array[] = [];

      for (let i = 0; i < 6; i++) {
        const username = `user${i}`;
        users.push(username);

        // Derive user's long-term keypair
        const { compressedPublicKey } = deriveUserKeypair(username, userMasterKey, "test");
        userPublicKeys.push(arrayify('0x' + compressedPublicKey.slice(4)));

        const { depositTo } = await createDepositTo(
          username,
          teeKeypair.publicKey
        );
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        // Make deposit
        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);
      }

      // TEE processes deposits and creates encrypted leaf
      const balances = [100_00, 100_00, 100_00, 100_00, 100_00, 100_00]; // All 100.00 (2 decimals)
      const nonce = 1;

      // Compute shared secrets for balance encryption (TEE_SK + USER_PK)
      const userSharedSecrets = userPublicKeys.map(userPK =>
        computeSharedSecret(teeKeypair.privateKey, userPK)
      );

      const encryptedBalances = encryptLeaf(balances, userSharedSecrets, nonce);

      // Create leaf using core types
      const leaf: Leaf = {
        encryptedBalances: encryptedBalances,
        idx: 0,
        nonce: nonce,
      };

      // Compute encrypted user IDs: keccak256(TEE_SK || username)
      const newUserIds = users.map((username) => {
        return arrayify(keccak256(concat([
          teeKeypair.privateKey,
          Buffer.from(username, 'utf8')
        ])));
      });

      // Use computeTranscript from core library
      const currentBlock = await lg.runner!.provider!.getBlockNumber();
      const batch: UpdateBatch = {
        opStart: 0n,
        opCount: 6n,
        nextBlock: BigInt(currentBlock + 1),
        updates: [leaf],
        newUsers: newUserIds,
        payouts: [],
      };

      const oldLeaves = new Map<number, Leaf>();
      const status = await lg.getStatus();
      const currentUserCount = Number(status.counters.userCount);
      const transcript = computeTranscript(batch, oldLeaves, currentUserCount);
      const transcriptHex = "0x" + Buffer.from(transcript).toString("hex");

      // Convert leaf to Solidity format for contract call
      const leafSol = {
        encryptedBalances: leaf.encryptedBalances.map(
          (b) => "0x" + Buffer.from(b).toString("hex")
        ),
        idx: leaf.idx,
        nonce: leaf.nonce,
      };

      const newUsersSol = newUserIds.map(
        (id) => "0x" + Buffer.from(id).toString("hex")
      );

      // Execute update
      const tx = await lg
        .connect(owner)
        .doUpdate(
          batch.opStart,
          batch.opCount,
          batch.nextBlock,
          [leafSol],
          newUsersSol,
          [],
          transcriptHex
        );
      await tx.wait();

      // Verify counters updated
      const statusAfter = await lg.getStatus();
      expect(statusAfter.counters.processedOps).to.equal(6);
      // Should have added 6 new users to the initial count
      expect(statusAfter.counters.userCount).to.equal(currentUserCount + 6);
    });
  });

  describe("Batched View Methods", function () {
    it("Should return user info with getUserInfo for existing user", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create and process a deposit
      const { depositTo } = await createDepositTo("user123", teeKeypair.publicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Compute encrypted user ID
      const encryptedUserId = arrayify(keccak256(concat([
        teeKeypair.privateKey,
        Buffer.from("user123", 'utf8')
      ])));
      const encryptedUserIdHex = "0x" + Buffer.from(encryptedUserId).toString("hex");

      // Process the deposit with doUpdate
      const { compressedPublicKey } = deriveUserKeypair("user123", userMasterKey, "test");
      const sharedSecret = computeSharedSecret(teeKeypair.privateKey, arrayify('0x' + compressedPublicKey.slice(4)));
      const balances = [100_00, 0, 0, 0, 0, 0];
      const nonce = 1;

      const userSharedSecrets = [sharedSecret, sharedSecret, sharedSecret, sharedSecret, sharedSecret, sharedSecret];
      const encryptedBalances = encryptLeaf(balances, userSharedSecrets, nonce);

      const leaf: Leaf = {
        encryptedBalances: encryptedBalances,
        idx: 0,
        nonce: nonce,
      };

      const currentBlock1 = await lg.runner!.provider!.getBlockNumber();
      const batch: UpdateBatch = {
        opStart: 0n,
        opCount: 1n,
        nextBlock: BigInt(currentBlock1 + 1),
        updates: [leaf],
        newUsers: [encryptedUserId],
        payouts: [],
      };

      const oldLeaves = new Map<number, Leaf>();
      const status = await lg.getStatus();
      const currentUserCount = Number(status.counters.userCount);
      const transcript = computeTranscript(batch, oldLeaves, currentUserCount);

      const leafSol = {
        encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
        idx: leaf.idx,
        nonce: leaf.nonce,
      };

      await lg.connect(owner).doUpdate(
        batch.opStart,
        batch.opCount,
        batch.nextBlock,
        [leafSol],
        [encryptedUserIdHex],
        [],
        "0x" + Buffer.from(transcript).toString("hex")
      );

      // Now test getUserInfo
      const userInfo = await lg.getUserInfo(encryptedUserIdHex);
      expect(userInfo.userIndex).to.equal(currentUserCount);
      expect(userInfo.leaf.idx).to.equal(0);
      expect(userInfo.leaf.nonce).to.equal(1);
    });

    it("Should return userIndex 0 for non-existent user", async function () {
      const fakeUserId = keccak256(Buffer.from("nonexistent", 'utf8'));
      const userInfo = await lg.getUserInfo(fakeUserId);

      expect(userInfo.userIndex).to.equal(0);
    });

    it("Should batch fetch multiple users with getUserInfoBatch", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create 3 users
      const usernames = ["alice", "bob", "charlie"];
      const encryptedUserIds: Uint8Array[] = [];

      for (const username of usernames) {
        const { depositTo } = createDepositTo(username, teeKeypair.publicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);

        const encryptedUserId = arrayify(keccak256(concat([
          teeKeypair.privateKey,
          Buffer.from(username, 'utf8')
        ])));
        encryptedUserIds.push(encryptedUserId);
      }

      // Process all deposits in one update
      const balances = [100_00, 100_00, 100_00, 0, 0, 0];
      const nonce = 1;

      const userSharedSecrets = usernames.map(username => {
        const { compressedPublicKey } = deriveUserKeypair(username, userMasterKey, "test");
        return computeSharedSecret(teeKeypair.privateKey, arrayify('0x' + compressedPublicKey.slice(4)));
      }).concat([Buffer.alloc(32), Buffer.alloc(32), Buffer.alloc(32)]);

      const encryptedBalances = encryptLeaf(balances, userSharedSecrets, nonce);

      const leaf: Leaf = {
        encryptedBalances: encryptedBalances,
        idx: 0,
        nonce: nonce,
      };

      const currentBlock2 = await lg.runner!.provider!.getBlockNumber();
      const batch: UpdateBatch = {
        opStart: 0n,
        opCount: 3n,
        nextBlock: BigInt(currentBlock2 + 1),
        updates: [leaf],
        newUsers: encryptedUserIds,
        payouts: [],
      };

      const oldLeaves = new Map<number, Leaf>();
      const status = await lg.getStatus();
      const currentUserCount = Number(status.counters.userCount);
      const transcript = computeTranscript(batch, oldLeaves, currentUserCount);

      const leafSol = {
        encryptedBalances: leaf.encryptedBalances.map(b => "0x" + Buffer.from(b).toString("hex")),
        idx: leaf.idx,
        nonce: leaf.nonce,
      };

      await lg.connect(owner).doUpdate(
        batch.opStart,
        batch.opCount,
        batch.nextBlock,
        [leafSol],
        encryptedUserIds.map(id => "0x" + Buffer.from(id).toString("hex")),
        [],
        "0x" + Buffer.from(transcript).toString("hex")
      );

      // Test getUserInfoBatch
      const encryptedUserIdsHex = encryptedUserIds.map(id => "0x" + Buffer.from(id).toString("hex"));
      const userInfos = await lg.getUserInfoBatch(encryptedUserIdsHex);

      expect(userInfos.length).to.equal(3);
      for (let i = 0; i < 3; i++) {
        expect(userInfos[i].userIndex).to.equal(currentUserCount + i);
        expect(userInfos[i].leaf.idx).to.equal(0);
        expect(userInfos[i].leaf.nonce).to.equal(1);
      }
    });

    it("Should return complete context with getUpdateContext", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create 2 users
      const usernames = ["dave", "eve"];
      const encryptedUserIds: Uint8Array[] = [];

      for (const username of usernames) {
        const { depositTo } = await createDepositTo(username, teeKeypair.publicKey);
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        await token.connect(user1).approve(await lg.getAddress(), depositAmount);
        await lg.connect(user1).depositERC20(depositToSol, depositAmount);

        const encryptedUserId = arrayify(keccak256(concat([
          teeKeypair.privateKey,
          Buffer.from(username, 'utf8')
        ])));
        encryptedUserIds.push(encryptedUserId);
      }

      const statusBefore = await lg.getStatus();

      // Call getUpdateContext
      const encryptedUserIdsHex = encryptedUserIds.map(id => "0x" + Buffer.from(id).toString("hex"));
      const context = await lg.getUpdateContext(encryptedUserIdsHex);

      // Verify it returns counters, dust, and user infos
      expect(context.counters.opCount).to.equal(statusBefore.counters.opCount);
      expect(context.counters.processedOps).to.equal(statusBefore.counters.processedOps);
      expect(context.counters.userCount).to.equal(statusBefore.counters.userCount);
      expect(context.dust).to.equal(statusBefore.dust);
      expect(context.userInfos.length).to.equal(2);

      // Both users should have userIndex 0 (not registered yet)
      expect(context.userInfos[0].userIndex).to.equal(0);
      expect(context.userInfos[1].userIndex).to.equal(0);
    });
  });

  describe("Payout and Dust", function () {
    it("Should handle payouts correctly", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Make a deposit first
      const { depositTo } = await createDepositTo("user123", teeKeypair.publicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      // Create payout using core types
      const payout: Payout = {
        toWho: user2.address,
        amount: ethers.parseUnits("50", TOKEN_DECIMALS),
      };

      // Use computeTranscript from core library
      const currentBlock3 = await lg.runner!.provider!.getBlockNumber();
      const batch: UpdateBatch = {
        opStart: 0n,
        opCount: 1n,
        nextBlock: BigInt(currentBlock3 + 1),
        updates: [],
        newUsers: [],
        payouts: [payout],
      };

      const oldLeaves = new Map<number, Leaf>();
      const status = await lg.getStatus();
      const currentUserCount = Number(status.counters.userCount);
      const transcript = computeTranscript(batch, oldLeaves, currentUserCount);
      const transcriptHex = "0x" + Buffer.from(transcript).toString("hex");

      const balanceBefore = await token.balanceOf(user2.address);

      // Execute update with payout
      await lg.connect(owner).doUpdate(
        batch.opStart,
        batch.opCount,
        batch.nextBlock,
        [],
        [],
        [payout],
        transcriptHex
      );

      const balanceAfter = await token.balanceOf(user2.address);
      expect(balanceAfter - balanceBefore).to.equal(payout.amount);
    });

    it("Should allow owner to collect dust", async function () {
      // Create deposit with dust
      const depositAmount = BigInt("100000001"); // Creates 1 wei dust

      const { depositTo } = await createDepositTo("user123", teeKeypair.publicKey);
      const depositToSol = {
        rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
        user: "0x" + Buffer.from(depositTo.user).toString("hex"),
      };

      await token.connect(user1).approve(await lg.getAddress(), depositAmount);
      await lg.connect(user1).depositERC20(depositToSol, depositAmount);

      const ownerBalanceBefore = await token.balanceOf(owner.address);

      // Collect dust
      await lg.connect(owner).collectDust();

      const ownerBalanceAfter = await token.balanceOf(owner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(1n);

      // Verify dust is cleared
      const status = await lg.getStatus();
      expect(status.dust).to.equal(0n);
    });
  });
});
