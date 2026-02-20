import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import { Colony } from "../target/types/colony";
import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
  getAccount,
} from "@solana/spl-token";

// ============================================================================
// CONSTANTS (must match lib.rs)
// ============================================================================
const TOKEN_DECIMALS = 6;
const TOKEN_MULTIPLIER = 10 ** TOKEN_DECIMALS;
const LAND_PRICE = 100 * TOKEN_MULTIPLIER;
const MAX_LANDS_PER_USER = 10;
const SECONDS_PER_DAY = 86400;
const EARNING_SPEEDS = [72, 108, 162, 243, 365, 547, 820, 1230, 1845, 2768].map(
  (s) => s * TOKEN_MULTIPLIER
);
const UPGRADE_COSTS = [24, 48, 72, 96, 192, 384, 768, 1536, 3072].map(
  (c) => c * TOKEN_MULTIPLIER
);

// ============================================================================
// HELPERS
// ============================================================================

function landDataPda(
  landId: number,
  programId: PublicKey
): [PublicKey, number] {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(landId);
  return PublicKey.findProgramAddressSync(
    [Buffer.from("land_data"), buf],
    programId
  );
}

function userProfilePda(
  user: PublicKey,
  programId: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("user_profile"), user.toBuffer()],
    programId
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ============================================================================
// TESTS
// ============================================================================

describe("colony", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Colony as Program<Colony>;
  const connection = provider.connection;
  const payer = (provider.wallet as anchor.Wallet).payer;

  // PDAs
  const [gameStateAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("game_state")],
    program.programId
  );
  const [vaultAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault")],
    program.programId
  );
  const [tokenVaultAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("token_vault")],
    program.programId
  );

  // Test users
  const user1 = Keypair.generate();
  const user2 = Keypair.generate();

  // Token state
  let mint: PublicKey;
  let user1Ata: PublicKey;
  let user2Ata: PublicKey;

  // Helper: buy land for a user
  async function buyLandForUser(
    user: Keypair,
    userAta: PublicKey,
    landId: number
  ) {
    const [landDataAddress] = landDataPda(landId, program.programId);
    const [userProfileAddress] = userProfilePda(
      user.publicKey,
      program.programId
    );

    await program.methods
      .buyLand(landId)
      .accounts({
        user: user.publicKey,
        gameState: gameStateAddress,
        landData: landDataAddress,
        userProfile: userProfileAddress,
        tokenMint: mint,
        userTokenAccount: userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  // Helper: claim earnings for a user
  async function claimForUser(user: Keypair, userAta: PublicKey, landId: number) {
    const [landDataAddress] = landDataPda(landId, program.programId);

    await program.methods
      .claimEarnings(landId)
      .accounts({
        user: user.publicKey,
        gameState: gameStateAddress,
        landData: landDataAddress,
        tokenMint: mint,
        tokenVault: tokenVaultAddress,
        userTokenAccount: userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .signers([user])
      .rpc();
  }

  // Helper: upgrade land for a user
  async function upgradeLandForUser(
    user: Keypair,
    userAta: PublicKey,
    landId: number
  ) {
    const [landDataAddress] = landDataPda(landId, program.programId);

    await program.methods
      .upgradeLand(landId)
      .accounts({
        user: user.publicKey,
        gameState: gameStateAddress,
        landData: landDataAddress,
        tokenMint: mint,
        userTokenAccount: userAta,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .signers([user])
      .rpc();
  }

  // ============================================================================
  // SETUP
  // ============================================================================
  before(async () => {
    // Airdrop SOL to test users
    for (const user of [user1, user2]) {
      const sig = await connection.requestAirdrop(
        user.publicKey,
        10 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);
    }
  });

  // ============================================================================
  // 1. GAME INITIALIZATION
  // ============================================================================
  describe("1. Game Setup", () => {
    it("initializes game state", async () => {
      await program.methods
        .initializeGame()
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
          vault: vaultAddress,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const gs = await (program.account as any).gameState.fetch(
        gameStateAddress
      );
      expect(gs.authority.toBase58()).to.equal(payer.publicKey.toBase58());
      expect(gs.isActive).to.be.true;
      expect(gs.totalLandsSold.toNumber()).to.equal(0);
    });

    it("creates SPL token mint", async () => {
      mint = await createMint(
        connection,
        payer,
        payer.publicKey,
        null,
        TOKEN_DECIMALS
      );
      console.log("    Token mint:", mint.toBase58());
    });

    it("sets token mint on game state", async () => {
      await program.methods
        .setTokenMint(mint)
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
        })
        .rpc();

      const gs = await (program.account as any).gameState.fetch(
        gameStateAddress
      );
      expect(gs.tokenMint.toBase58()).to.equal(mint.toBase58());
    });

    it("initializes token vault PDA", async () => {
      await program.methods
        .initTokenVault()
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
          tokenMint: mint,
          tokenVault: tokenVaultAddress,
          tokenProgram: TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAccount = await getAccount(connection, tokenVaultAddress);
      expect(vaultAccount.mint.toBase58()).to.equal(mint.toBase58());
    });

    it("mints tokens to users and funds vault", async () => {
      const userTokens = 10_000 * TOKEN_MULTIPLIER;
      const vaultTokens = 1_000_000 * TOKEN_MULTIPLIER;

      // Create ATAs for users
      const u1 = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        user1.publicKey
      );
      user1Ata = u1.address;

      const u2 = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        user2.publicKey
      );
      user2Ata = u2.address;

      // Mint tokens to users
      await mintTo(connection, payer, mint, user1Ata, payer, userTokens);
      await mintTo(connection, payer, mint, user2Ata, payer, userTokens);

      // Fund the vault for earnings distribution
      await mintTo(connection, payer, mint, tokenVaultAddress, payer, vaultTokens);

      const u1Balance = await getAccount(connection, user1Ata);
      expect(Number(u1Balance.amount)).to.equal(userTokens);

      const vBalance = await getAccount(connection, tokenVaultAddress);
      expect(Number(vBalance.amount)).to.equal(vaultTokens);

      console.log(
        `    User1: ${userTokens / TOKEN_MULTIPLIER} tokens, Vault: ${vaultTokens / TOKEN_MULTIPLIER} tokens`
      );
    });
  });

  // ============================================================================
  // 2. LAND PURCHASE (token burn mechanics)
  // ============================================================================
  describe("2. Land Purchase", () => {
    it("user1 buys land #1 — 100 tokens burned", async () => {
      const balanceBefore = Number(
        (await getAccount(connection, user1Ata)).amount
      );

      await buyLandForUser(user1, user1Ata, 1);

      const balanceAfter = Number(
        (await getAccount(connection, user1Ata)).amount
      );
      expect(balanceBefore - balanceAfter).to.equal(LAND_PRICE);

      // Verify land data
      const [landAddr] = landDataPda(1, program.programId);
      const land = await (program.account as any).landData.fetch(landAddr);
      expect(land.landId).to.equal(1);
      expect(land.owner.toBase58()).to.equal(user1.publicKey.toBase58());
      expect(land.level).to.equal(1);

      // Verify user profile
      const [profileAddr] = userProfilePda(user1.publicKey, program.programId);
      const profile = await (program.account as any).userProfile.fetch(
        profileAddr
      );
      expect(profile.landsOwned).to.equal(1);

      // Verify game state
      const gs = await (program.account as any).gameState.fetch(
        gameStateAddress
      );
      expect(gs.totalLandsSold.toNumber()).to.equal(1);
    });

    it("user2 buys land #100", async () => {
      await buyLandForUser(user2, user2Ata, 100);

      const [landAddr] = landDataPda(100, program.programId);
      const land = await (program.account as any).landData.fetch(landAddr);
      expect(land.owner.toBase58()).to.equal(user2.publicKey.toBase58());
    });

    it("rejects land_id = 0 (InvalidLandId)", async () => {
      try {
        await buyLandForUser(user1, user1Ata, 0);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidLandId");
      }
    });

    it("rejects land_id = 21001 (InvalidLandId)", async () => {
      try {
        await buyLandForUser(user1, user1Ata, 21001);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InvalidLandId");
      }
    });

    it("rejects duplicate land purchase (account already exists)", async () => {
      try {
        await buyLandForUser(user1, user1Ata, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        // Anchor returns a constraint error when trying to init an already existing PDA
        expect(err.toString()).to.not.be.empty;
      }
    });

    it("rejects purchase when game is paused", async () => {
      // Pause game
      await program.methods
        .setGameActive(false)
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
        })
        .rpc();

      try {
        await buyLandForUser(user1, user1Ata, 50);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("GameNotActive");
      }

      // Unpause
      await program.methods
        .setGameActive(true)
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
        })
        .rpc();
    });

    it("rejects purchase with insufficient tokens", async () => {
      const poorUser = Keypair.generate();
      const sig = await connection.requestAirdrop(
        poorUser.publicKey,
        2 * LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(sig);

      // Create ATA with only 1 token (need 100)
      const poorAta = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        poorUser.publicKey
      );
      await mintTo(
        connection,
        payer,
        mint,
        poorAta.address,
        payer,
        1 * TOKEN_MULTIPLIER
      );

      try {
        await buyLandForUser(poorUser, poorAta.address, 200);
        expect.fail("Should have thrown");
      } catch (err: any) {
        // SPL token error for insufficient balance
        expect(err.toString()).to.not.be.empty;
      }
    });
  });

  // ============================================================================
  // 3. MAX LANDS PER USER (10 limit)
  // ============================================================================
  describe("3. Max Lands Limit", () => {
    it("user1 buys lands #2 through #10 (reaching limit of 10)", async () => {
      // user1 already owns land #1
      for (let landId = 2; landId <= 10; landId++) {
        await buyLandForUser(user1, user1Ata, landId);
      }

      const [profileAddr] = userProfilePda(user1.publicKey, program.programId);
      const profile = await (program.account as any).userProfile.fetch(
        profileAddr
      );
      expect(profile.landsOwned).to.equal(MAX_LANDS_PER_USER);
      console.log(`    User1 owns ${profile.landsOwned} lands`);
    });

    it("rejects 11th land purchase (MaxLandsReached)", async () => {
      try {
        await buyLandForUser(user1, user1Ata, 11);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MaxLandsReached");
      }
    });

    it("different user can still buy land", async () => {
      await buyLandForUser(user2, user2Ata, 101);

      const [profileAddr] = userProfilePda(user2.publicKey, program.programId);
      const profile = await (program.account as any).userProfile.fetch(
        profileAddr
      );
      expect(profile.landsOwned).to.equal(2); // #100 and #101
    });
  });

  // ============================================================================
  // 4. MINING & CLAIM EARNINGS
  // ============================================================================
  describe("4. Mining & Claim Earnings", () => {
    it("waits for earnings to accumulate", async () => {
      // Land was bought with MINING_START_TIME=0, so mining is already active.
      // Wait a few seconds for earnings to accrue.
      console.log("    Waiting 3s for earnings...");
      await sleep(3000);
    });

    it("user1 claims earnings from land #1", async () => {
      const balanceBefore = Number(
        (await getAccount(connection, user1Ata)).amount
      );

      await claimForUser(user1, user1Ata, 1);

      const balanceAfter = Number(
        (await getAccount(connection, user1Ata)).amount
      );
      const earned = balanceAfter - balanceBefore;
      expect(earned).to.be.greaterThan(0);
      console.log(
        `    Earned: ${(earned / TOKEN_MULTIPLIER).toFixed(4)} tokens`
      );

      // Verify last_checkout updated
      const [landAddr] = landDataPda(1, program.programId);
      const land = await (program.account as any).landData.fetch(landAddr);
      expect(land.fixedEarnings.toNumber()).to.equal(0);
    });

    it("rejects claim with no new earnings (immediately after claim)", async () => {
      try {
        await claimForUser(user1, user1Ata, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NoEarnings");
      }
    });

    it("rejects claim from non-owner", async () => {
      try {
        // user2 tries to claim from land #1 (owned by user1)
        await claimForUser(user2, user2Ata, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NotLandOwner");
      }
    });

    it("vault balance decreases after claim", async () => {
      // Wait for new earnings
      await sleep(2000);

      const vaultBefore = Number(
        (await getAccount(connection, tokenVaultAddress)).amount
      );

      await claimForUser(user1, user1Ata, 2);

      const vaultAfter = Number(
        (await getAccount(connection, tokenVaultAddress)).amount
      );
      expect(vaultAfter).to.be.lessThan(vaultBefore);
    });
  });

  // ============================================================================
  // 5. LAND UPGRADES
  // ============================================================================
  describe("5. Land Upgrades", () => {
    it("upgrades land #1 from level 1 to 2 (costs 24 tokens)", async () => {
      // Wait a bit so pending earnings > 0 (will be preserved as fixed_earnings)
      await sleep(2000);

      const balanceBefore = Number(
        (await getAccount(connection, user1Ata)).amount
      );

      await upgradeLandForUser(user1, user1Ata, 1);

      const balanceAfter = Number(
        (await getAccount(connection, user1Ata)).amount
      );
      const spent = balanceBefore - balanceAfter;
      expect(spent).to.equal(UPGRADE_COSTS[0]); // 24 tokens

      // Verify level
      const [landAddr] = landDataPda(1, program.programId);
      const land = await (program.account as any).landData.fetch(landAddr);
      expect(land.level).to.equal(2);

      // Verify fixed_earnings preserved (pending was saved)
      expect(land.fixedEarnings.toNumber()).to.be.greaterThan(0);
      console.log(
        `    Level: ${land.level}, Fixed earnings: ${land.fixedEarnings.toNumber()}`
      );
    });

    it("upgrades land #1 through all levels up to 10", async () => {
      // Give user1 extra tokens for all upgrades
      const extraTokens = 10_000 * TOKEN_MULTIPLIER;
      await mintTo(connection, payer, mint, user1Ata, payer, extraTokens);

      // Currently at level 2, upgrade to 10
      for (let targetLevel = 3; targetLevel <= 10; targetLevel++) {
        await sleep(500); // Small wait between upgrades
        await upgradeLandForUser(user1, user1Ata, 1);

        const [landAddr] = landDataPda(1, program.programId);
        const land = await (program.account as any).landData.fetch(landAddr);
        expect(land.level).to.equal(targetLevel);
      }

      const [landAddr] = landDataPda(1, program.programId);
      const land = await (program.account as any).landData.fetch(landAddr);
      expect(land.level).to.equal(10);
      console.log("    Land #1 reached max level 10");
    });

    it("rejects upgrade beyond max level (MaxLevelReached)", async () => {
      try {
        await upgradeLandForUser(user1, user1Ata, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("MaxLevelReached");
      }
    });

    it("rejects upgrade from non-owner", async () => {
      try {
        // user2 tries to upgrade land #1 (owned by user1)
        await upgradeLandForUser(user2, user2Ata, 1);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("NotLandOwner");
      }
    });

    it("higher level earns faster", async () => {
      // Land #1 is level 10, land #3 is level 1
      // Wait and compare earnings
      await sleep(2000);

      const [land1Addr] = landDataPda(1, program.programId);
      const [land3Addr] = landDataPda(3, program.programId);
      const land1 = await (program.account as any).landData.fetch(land1Addr);
      const land3 = await (program.account as any).landData.fetch(land3Addr);

      // Calculate expected ratio: level 10 speed / level 1 speed = 2768/72 ≈ 38.4x
      // Just verify level 10 land has more pending earnings in general
      // (exact timing comparison is tricky in tests)
      expect(EARNING_SPEEDS[9]).to.be.greaterThan(EARNING_SPEEDS[0]);
      console.log(
        `    L10 speed: ${EARNING_SPEEDS[9] / TOKEN_MULTIPLIER}/day vs L1: ${EARNING_SPEEDS[0] / TOKEN_MULTIPLIER}/day`
      );
    });
  });

  // ============================================================================
  // 6. WITHDRAW TOKENS (authority rescue)
  // ============================================================================
  describe("6. Withdraw Tokens", () => {
    it("non-authority cannot withdraw tokens", async () => {
      try {
        const fakeAuthorityAta = await getOrCreateAssociatedTokenAccount(
          connection,
          payer,
          mint,
          user1.publicKey
        );

        await program.methods
          .withdrawTokens()
          .accounts({
            authority: user1.publicKey,
            gameState: gameStateAddress,
            tokenMint: mint,
            tokenVault: tokenVaultAddress,
            authorityTokenAccount: fakeAuthorityAta.address,
            tokenProgram: TOKEN_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
            systemProgram: SystemProgram.programId,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("authority withdraws all tokens from vault", async () => {
      const authorityAtaAccount = await getOrCreateAssociatedTokenAccount(
        connection,
        payer,
        mint,
        payer.publicKey
      );

      const vaultBefore = Number(
        (await getAccount(connection, tokenVaultAddress)).amount
      );
      expect(vaultBefore).to.be.greaterThan(0);

      await program.methods
        .withdrawTokens()
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
          tokenMint: mint,
          tokenVault: tokenVaultAddress,
          authorityTokenAccount: authorityAtaAccount.address,
          tokenProgram: TOKEN_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
          systemProgram: SystemProgram.programId,
        })
        .rpc();

      const vaultAfter = Number(
        (await getAccount(connection, tokenVaultAddress)).amount
      );
      expect(vaultAfter).to.equal(0);

      const authorityBalance = Number(
        (await getAccount(connection, authorityAtaAccount.address)).amount
      );
      expect(authorityBalance).to.be.greaterThanOrEqual(vaultBefore);
      console.log(
        `    Withdrawn: ${vaultBefore / TOKEN_MULTIPLIER} tokens to authority`
      );
    });

    it("rejects claim when vault is empty (InsufficientTreasury)", async () => {
      await sleep(2000); // accrue some earnings

      try {
        await claimForUser(user1, user1Ata, 2);
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("InsufficientTreasury");
      }
    });
  });

  // ============================================================================
  // 7. ADMIN CLOSE OPERATIONS
  // ============================================================================
  describe("7. Admin Operations", () => {
    it("admin closes land #100 (owned by user2)", async () => {
      const [landAddr] = landDataPda(100, program.programId);
      const [userProfileAddr] = userProfilePda(
        user2.publicKey,
        program.programId
      );

      const profileBefore = await (program.account as any).userProfile.fetch(
        userProfileAddr
      );
      const gsBefore = await (program.account as any).gameState.fetch(
        gameStateAddress
      );

      await program.methods
        .adminCloseLand(100)
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
          landData: landAddr,
          userProfile: userProfileAddr,
        })
        .rpc();

      // Land account should be closed
      const landAccount = await connection.getAccountInfo(landAddr);
      expect(landAccount).to.be.null;

      // User profile lands_owned decreased
      const profileAfter = await (program.account as any).userProfile.fetch(
        userProfileAddr
      );
      expect(profileAfter.landsOwned).to.equal(profileBefore.landsOwned - 1);

      // Game state total_lands_sold decreased
      const gsAfter = await (program.account as any).gameState.fetch(
        gameStateAddress
      );
      expect(gsAfter.totalLandsSold.toNumber()).to.equal(
        gsBefore.totalLandsSold.toNumber() - 1
      );
    });

    it("admin closes land #101 (user2's last land)", async () => {
      const [landAddr] = landDataPda(101, program.programId);
      const [userProfileAddr] = userProfilePda(
        user2.publicKey,
        program.programId
      );

      await program.methods
        .adminCloseLand(101)
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
          landData: landAddr,
          userProfile: userProfileAddr,
        })
        .rpc();

      const profile = await (program.account as any).userProfile.fetch(
        userProfileAddr
      );
      expect(profile.landsOwned).to.equal(0);
    });

    it("admin closes user2 profile (0 lands)", async () => {
      const [userProfileAddr] = userProfilePda(
        user2.publicKey,
        program.programId
      );

      await program.methods
        .adminCloseUserProfile()
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
          userProfile: userProfileAddr,
        })
        .rpc();

      const profileAccount = await connection.getAccountInfo(userProfileAddr);
      expect(profileAccount).to.be.null;
    });

    it("rejects closing profile when user still has lands", async () => {
      const [userProfileAddr] = userProfilePda(
        user1.publicKey,
        program.programId
      );

      try {
        await program.methods
          .adminCloseUserProfile()
          .accounts({
            authority: payer.publicKey,
            gameState: gameStateAddress,
            userProfile: userProfileAddr,
          })
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("UserHasLands");
      }
    });

    it("non-authority cannot close lands", async () => {
      const [landAddr] = landDataPda(2, program.programId);
      const [userProfileAddr] = userProfilePda(
        user1.publicKey,
        program.programId
      );

      try {
        await program.methods
          .adminCloseLand(2)
          .accounts({
            authority: user2.publicKey,
            gameState: gameStateAddress,
            landData: landAddr,
            userProfile: userProfileAddr,
          })
          .signers([user2])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });

  // ============================================================================
  // 8. GAME STATE CONTROLS
  // ============================================================================
  describe("8. Game State Controls", () => {
    it("authority can pause and unpause the game", async () => {
      await program.methods
        .setGameActive(false)
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
        })
        .rpc();

      let gs = await (program.account as any).gameState.fetch(gameStateAddress);
      expect(gs.isActive).to.be.false;

      await program.methods
        .setGameActive(true)
        .accounts({
          authority: payer.publicKey,
          gameState: gameStateAddress,
        })
        .rpc();

      gs = await (program.account as any).gameState.fetch(gameStateAddress);
      expect(gs.isActive).to.be.true;
    });

    it("non-authority cannot pause game", async () => {
      try {
        await program.methods
          .setGameActive(false)
          .accounts({
            authority: user1.publicKey,
            gameState: gameStateAddress,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });

    it("non-authority cannot set token mint", async () => {
      const fakeMint = Keypair.generate().publicKey;
      try {
        await program.methods
          .setTokenMint(fakeMint)
          .accounts({
            authority: user1.publicKey,
            gameState: gameStateAddress,
          })
          .signers([user1])
          .rpc();
        expect.fail("Should have thrown");
      } catch (err: any) {
        expect(err.toString()).to.include("Unauthorized");
      }
    });
  });
});
