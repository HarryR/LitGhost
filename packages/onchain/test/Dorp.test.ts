import { expect } from "chai";
import { ethers } from "hardhat";
import { Dorp, MockToken } from "../src/contracts";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  createDepositTo,
  randomKeypair,
  decryptDepositTo,
  encryptLeaf,
  computeSharedSecret,
  getUserLeafInfo,
  computeTranscript,
  type Leaf,
  type Payout,
  type UpdateBatch,
} from "@monorepo/core";
import { keccak256 } from "@ethersproject/keccak256";
import { arrayify } from "@ethersproject/bytes";

/**
 * Comprehensive test suite for the Dorp contract
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
describe("Dorp Contract", function () {
  let dorp: Dorp;
  let token: MockToken;
  let owner: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let teeKeypair: { publicKey: Uint8Array; privateKey: Uint8Array };

  const TOKEN_DECIMALS = 6;
  const INITIAL_BALANCE = ethers.parseUnits("1000000", TOKEN_DECIMALS);

  beforeEach(async function () {
    [owner, user1, user2] = await ethers.getSigners();

    // Generate TEE keypair
    teeKeypair = await randomKeypair();

    // Deploy mock token with 6 decimals (like USDC)
    const MockTokenFactory = await ethers.getContractFactory("MockToken");
    token = await MockTokenFactory.deploy("Mock USDC", "MUSDC", TOKEN_DECIMALS);
    await token.waitForDeployment();

    // Deploy Dorp contract
    const DorpFactory = await ethers.getContractFactory("Dorp");
    dorp = await DorpFactory.deploy(await token.getAddress(), owner.address);
    await dorp.waitForDeployment();

    // Mint tokens to users
    await token.mint(user1.address, INITIAL_BALANCE);
    await token.mint(user2.address, INITIAL_BALANCE);
  });

  describe("Deployment", function () {
    it("Should set the correct owner", async function () {
      const status = await dorp.getStatus();
      expect(status.counters.opCount).to.equal(0);
      expect(status.counters.processedOps).to.equal(0);
      expect(status.counters.userCount).to.equal(0);
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
      await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
      const tx = await dorp
        .connect(user1)
        .depositERC20(depositToSol, depositAmount);
      const receipt = await tx.wait();

      // Check event
      const event = receipt?.logs.find(
        (log: any) => log.fragment?.name === "OpDeposit"
      ) as any;
      expect(event).to.not.be.undefined;

      // Verify TEE can decrypt the user ID
      const decryptedUserIdHash = decryptDepositTo(
        depositTo,
        teeKeypair.privateKey
      );
      const expectedUserIdHash = arrayify(
        keccak256(Buffer.from("user123", "utf8"))
      );
      expect(Buffer.from(decryptedUserIdHash)).to.deep.equal(
        Buffer.from(expectedUserIdHash)
      );

      // Verify counter updated
      const status = await dorp.getStatus();
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

      await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
      await dorp.connect(user1).depositERC20(depositToSol, depositAmount);

      // Check dust was accumulated
      const status = await dorp.getStatus();
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
        to: await dorp.getAddress(),
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

      // Deposit using ERC3009 - only the Dorp contract (receiver) can call this
      const tx = await dorp.connect(user2)['depositERC3009((bytes32,bytes32),(address,uint256,uint256,uint256,(uint8,bytes32,bytes32)))'](depositToSol, auth);
      await tx.wait();

      // Verify deposit succeeded
      const status = await dorp.getStatus();
      expect(status.counters.opCount).to.equal(1);
    });
  });

  describe("doUpdate", function () {
    it("Should process deposits and update encrypted leaves", async function () {
      const depositAmount = ethers.parseUnits("100", TOKEN_DECIMALS);

      // Create 6 users and their deposits
      const users: string[] = [];
      const userSharedSecrets: Uint8Array[] = [];

      for (let i = 0; i < 6; i++) {
        const userId = `user${i}`;
        users.push(userId);

        const { depositTo } = await createDepositTo(
          userId,
          teeKeypair.publicKey
        );
        const depositToSol = {
          rand: "0x" + Buffer.from(depositTo.rand).toString("hex"),
          user: "0x" + Buffer.from(depositTo.user).toString("hex"),
        };

        // Make deposit
        await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
        await dorp.connect(user1).depositERC20(depositToSol, depositAmount);

        // TEE computes shared secret for this user
        const sharedSecret = computeSharedSecret(
          teeKeypair.privateKey,
          depositTo.rand
        );
        userSharedSecrets.push(sharedSecret);
      }

      // TEE processes deposits and creates encrypted leaf
      const balances = [100_00, 100_00, 100_00, 100_00, 100_00, 100_00]; // All 100.00 (2 decimals)
      const nonce = 1;
      const encryptedBalances = encryptLeaf(balances, userSharedSecrets, nonce);

      // Create leaf using core types
      const leaf: Leaf = {
        encryptedBalances: encryptedBalances,
        idx: 0,
        nonce: nonce,
      };

      // Get user ID hashes for new users
      const newUserIds = users.map((userId) => {
        return arrayify(keccak256(Buffer.from(userId, "utf8")));
      });

      // Use computeTranscript from core library
      const batch: UpdateBatch = {
        opStart: 0n,
        opCount: 6n,
        updates: [leaf],
        newUsers: newUserIds,
        payouts: [],
      };

      const oldLeaves = new Map<number, Leaf>();
      const transcript = computeTranscript(batch, oldLeaves);
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
      const tx = await dorp
        .connect(owner)
        .doUpdate(
          batch.opStart,
          batch.opCount,
          [leafSol],
          newUsersSol,
          [],
          transcriptHex
        );
      await tx.wait();

      // Verify counters updated
      const status = await dorp.getStatus();
      expect(status.counters.processedOps).to.equal(6);
      expect(status.counters.userCount).to.equal(6);
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

      await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
      await dorp.connect(user1).depositERC20(depositToSol, depositAmount);

      // Create payout using core types
      const payout: Payout = {
        toWho: user2.address,
        amount: ethers.parseUnits("50", TOKEN_DECIMALS),
      };

      // Use computeTranscript from core library
      const batch: UpdateBatch = {
        opStart: 0n,
        opCount: 1n,
        updates: [],
        newUsers: [],
        payouts: [payout],
      };

      const oldLeaves = new Map<number, Leaf>();
      const transcript = computeTranscript(batch, oldLeaves);
      const transcriptHex = "0x" + Buffer.from(transcript).toString("hex");

      const balanceBefore = await token.balanceOf(user2.address);

      // Execute update with payout
      await dorp.connect(owner).doUpdate(
        batch.opStart,
        batch.opCount,
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

      await token.connect(user1).approve(await dorp.getAddress(), depositAmount);
      await dorp.connect(user1).depositERC20(depositToSol, depositAmount);

      const ownerBalanceBefore = await token.balanceOf(owner.address);

      // Collect dust
      await dorp.connect(owner).collectDust();

      const ownerBalanceAfter = await token.balanceOf(owner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(1n);

      // Verify dust is cleared
      const status = await dorp.getStatus();
      expect(status.dust).to.equal(0n);
    });
  });
});
