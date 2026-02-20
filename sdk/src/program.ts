import { Program, AnchorProvider, BN } from "@coral-xyz/anchor";
import {
  PublicKey,
  Connection,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { IDL, PROGRAM_ID } from "./idl";

// ============================================================================
// CONSTANTS
// ============================================================================

/** Game token mint ($OLO on pump.fun) */
export const GAME_TOKEN_MINT = new PublicKey("2pXjxbdHnYWtH2gtDN495Ve1jm8bs1zoUL6XsUi3pump");

export const MAX_LAND_ID = 21000;
export const MAX_LANDS_PER_USER = 10;
export const MIN_LAND_ID = 1;
export const MAX_LEVEL = 10;
export const TOKEN_DECIMALS = 6;
export const TOKEN_MULTIPLIER = 1_000_000;
export const LAND_PRICE_TOKENS = 10_000 * TOKEN_MULTIPLIER; // 10,000 tokens (burned on purchase)
export const SECONDS_PER_DAY = 86400;

/** Mining launch time: 2026-02-17 16:00 CET */
export const MINING_START_TIME = 1771340400;


/** Upgrade costs in tokens (index 0 = level 1→2) */
export const UPGRADE_COSTS = [
  1_000 * TOKEN_MULTIPLIER, // 1 → 2
  2_000 * TOKEN_MULTIPLIER, // 2 → 3
  4_000 * TOKEN_MULTIPLIER, // 3 → 4
  8_000 * TOKEN_MULTIPLIER, // 4 → 5
  16_000 * TOKEN_MULTIPLIER, // 5 → 6
  32_000 * TOKEN_MULTIPLIER, // 6 → 7
  64_000 * TOKEN_MULTIPLIER, // 7 → 8
  128_000 * TOKEN_MULTIPLIER, // 8 → 9
  152_000 * TOKEN_MULTIPLIER, // 9 → 10
];

/** Earning speeds in tokens per day (index 0 = level 1) */
export const EARNING_SPEEDS = [
  1_000 * TOKEN_MULTIPLIER, // Level 1
  2_000 * TOKEN_MULTIPLIER, // Level 2
  3_000 * TOKEN_MULTIPLIER, // Level 3
  5_000 * TOKEN_MULTIPLIER, // Level 4
  8_000 * TOKEN_MULTIPLIER, // Level 5
  13_000 * TOKEN_MULTIPLIER, // Level 6
  21_000 * TOKEN_MULTIPLIER, // Level 7
  34_000 * TOKEN_MULTIPLIER, // Level 8
  45_000 * TOKEN_MULTIPLIER, // Level 9
  79_000 * TOKEN_MULTIPLIER, // Level 10
];

// ============================================================================
// TYPES
// ============================================================================

export interface ColonyClientConfig {
  connection: Connection;
  wallet?: AnchorProvider["wallet"];
}

export interface GameState {
  authority: PublicKey;
  treasuryBalance: BN;
  totalLandsSold: BN;
  totalSolCollected: BN;
  isActive: boolean;
  bump: number;
  vaultBump: number;
  tokenMint: PublicKey;
  tokenVaultBump: number;
}

export interface LandData {
  landId: number;
  owner: PublicKey;
  level: number;
  fixedEarnings: BN;
  lastCheckout: BN;
  bump: number;
}

export interface UserProfile {
  owner: PublicKey;
  landsOwned: number;
  tokenBalance: BN;
  bump: number;
}

/** Token context for building instructions that need SPL token accounts */
interface TokenContext {
  tokenMint: PublicKey;
  tokenVaultAddress: PublicKey;
}

/** Result of batch claim operation */
export interface BatchClaimResult {
  successfulLandIds: number[];
  failedLandIds: number[];
  totalClaimed: BN;
  txSignatures: string[];
}

/** Progress callback for batch operations */
export type BatchProgressCallback = (progress: {
  currentBatch: number;
  totalBatches: number;
  processedLands: number;
  totalLands: number;
}) => void;

/** Max claims per transaction (conservative limit for compute budget) */
const MAX_CLAIMS_PER_TX = 10;

// ============================================================================
// PDA DERIVATION
// ============================================================================

const encoder = new TextEncoder();

export function gameStatePda(programId: PublicKey = new PublicKey(PROGRAM_ID)) {
  return PublicKey.findProgramAddressSync(
    [encoder.encode("game_state")],
    programId
  );
}

export function vaultPda(programId: PublicKey = new PublicKey(PROGRAM_ID)) {
  return PublicKey.findProgramAddressSync([encoder.encode("vault")], programId);
}

export function tokenVaultPda(programId: PublicKey = new PublicKey(PROGRAM_ID)) {
  return PublicKey.findProgramAddressSync(
    [encoder.encode("token_vault")],
    programId
  );
}

/** Convert u16 to little-endian bytes */
function u16ToLeBytes(value: number): Uint8Array {
  const bytes = new Uint8Array(2);
  bytes[0] = value & 0xff;
  bytes[1] = (value >> 8) & 0xff;
  return bytes;
}

export function landDataPda(
  landId: number,
  programId: PublicKey = new PublicKey(PROGRAM_ID)
) {
  return PublicKey.findProgramAddressSync(
    [encoder.encode("land_data"), u16ToLeBytes(landId)],
    programId
  );
}

export function userProfilePda(
  user: PublicKey,
  programId: PublicKey = new PublicKey(PROGRAM_ID)
) {
  return PublicKey.findProgramAddressSync(
    [encoder.encode("user_profile"), user.toBuffer()],
    programId
  );
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Calculate pending earnings for a land
 */
export function calculateEarnings(land: LandData, currentTime: number): BN {
  if (currentTime < MINING_START_TIME) {
    return land.fixedEarnings;
  }

  const timePassed = new BN(currentTime).sub(land.lastCheckout);
  const speed = new BN(EARNING_SPEEDS[land.level - 1]);

  const earned = speed
    .mul(timePassed)
    .div(new BN(SECONDS_PER_DAY))
    .add(land.fixedEarnings);

  return earned;
}

/**
 * Get upgrade cost for next level
 */
export function getUpgradeCost(currentLevel: number): BN {
  if (currentLevel < 1 || currentLevel >= MAX_LEVEL) {
    return new BN(0);
  }
  return new BN(UPGRADE_COSTS[currentLevel - 1]);
}

/**
 * Get earning speed for a level (tokens per day)
 */
export function getEarningSpeed(level: number): BN {
  if (level < 1 || level > MAX_LEVEL) {
    return new BN(0);
  }
  return new BN(EARNING_SPEEDS[level - 1]);
}

/**
 * Validate land ID (must be 1-21000)
 */
export function isValidLandId(landId: number): boolean {
  return landId >= MIN_LAND_ID && landId <= MAX_LAND_ID;
}

// ============================================================================
// CLIENT
// ============================================================================

export function createColonyClient(config: ColonyClientConfig) {
  const { connection, wallet } = config;

  const programId = new PublicKey(PROGRAM_ID);

  const provider = wallet
    ? new AnchorProvider(connection, wallet, {
        commitment: "confirmed",
        preflightCommitment: "confirmed",
      })
    : ({
        connection,
        publicKey: null,
      } as unknown as AnchorProvider);

  const program = new Program(IDL, provider);

  const [gameStateAddress] = gameStatePda(programId);
  const [vaultAddress] = vaultPda(programId);
  const [tokenVaultAddress] = tokenVaultPda(programId);

  // ========== HELPERS ==========

  /** Send a signed transaction and confirm via polling (works with Alchemy) */
  async function sendAndConfirmTx(signedTx: Transaction): Promise<string> {
    const rawTx = signedTx.serialize();
    const signature = await connection.sendRawTransaction(rawTx, {
      skipPreflight: false,
      maxRetries: 5,
    });

    // Poll for confirmation instead of WebSocket (Alchemy doesn't support signatureSubscribe)
    const timeout = 60_000;
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const status = await connection.getSignatureStatus(signature);
      if (status?.value?.confirmationStatus === "confirmed" || status?.value?.confirmationStatus === "finalized") {
        if (status.value.err) {
          throw new Error(`Transaction failed: ${JSON.stringify(status.value.err)}`);
        }
        return signature;
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    // If we timed out, check one more time
    const finalStatus = await connection.getSignatureStatus(signature);
    if (finalStatus?.value?.confirmationStatus) {
      if (finalStatus.value.err) {
        throw new Error(`Transaction failed: ${JSON.stringify(finalStatus.value.err)}`);
      }
      return signature;
    }
    throw new Error(`Transaction confirmation timeout for ${signature}`);
  }

  // ========== READ METHODS ==========

  async function getGameState(): Promise<GameState | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const account = await (program.account as any).gameState.fetch(
        gameStateAddress
      );
      return {
        authority: account.authority,
        treasuryBalance: account.treasuryBalance,
        totalLandsSold: account.totalLandsSold,
        totalSolCollected: account.totalSolCollected,
        isActive: account.isActive,
        bump: account.bump,
        vaultBump: account.vaultBump,
        tokenMint: account.tokenMint,
        tokenVaultBump: account.tokenVaultBump,
      };
    } catch {
      return null;
    }
  }

  async function getLandData(landId: number): Promise<LandData | null> {
    if (!isValidLandId(landId)) return null;

    try {
      const [landDataAddress] = landDataPda(landId, programId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const account = await (program.account as any).landData.fetch(
        landDataAddress
      );
      return {
        landId: account.landId,
        owner: account.owner,
        level: account.level,
        fixedEarnings: account.fixedEarnings,
        lastCheckout: account.lastCheckout,
        bump: account.bump,
      };
    } catch {
      return null;
    }
  }

  async function isLandOwned(landId: number): Promise<boolean> {
    const landData = await getLandData(landId);
    return landData !== null;
  }

  async function isLandOwnedBy(
    landId: number,
    owner: PublicKey
  ): Promise<boolean> {
    const landData = await getLandData(landId);
    if (!landData) return false;
    return landData.owner.equals(owner);
  }

  async function getVaultBalance(): Promise<number> {
    return await connection.getBalance(vaultAddress);
  }

  async function isGameInitialized(): Promise<boolean> {
    const state = await getGameState();
    return state !== null;
  }

  async function getPendingEarnings(landId: number): Promise<BN> {
    const landData = await getLandData(landId);
    if (!landData) {
      return new BN(0);
    }

    const currentTime = Math.floor(Date.now() / 1000);
    return calculateEarnings(landData, currentTime);
  }

  async function getUserProfile(user: PublicKey): Promise<UserProfile | null> {
    try {
      const [address] = userProfilePda(user, programId);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const account = await (program.account as any).userProfile.fetch(address);
      return {
        owner: account.owner,
        landsOwned: account.landsOwned,
        tokenBalance: account.tokenBalance,
        bump: account.bump,
      };
    } catch {
      return null;
    }
  }

  async function getUserLandCount(user: PublicKey): Promise<number> {
    const profile = await getUserProfile(user);
    return profile?.landsOwned ?? 0;
  }

  /**
   * Get token context (mint + vault address) from game state.
   * Fetches game state to determine the current token mint.
   */
  async function getTokenContext(): Promise<TokenContext> {
    const state = await getGameState();
    if (!state) throw new Error("Game not initialized");
    return {
      tokenMint: state.tokenMint,
      tokenVaultAddress,
    };
  }

  /**
   * Get user's associated token account address for the game token
   */
  function getUserTokenAccountAddress(
    mint: PublicKey,
    user: PublicKey
  ): PublicKey {
    return getAssociatedTokenAddressSync(mint, user, true, TOKEN_2022_PROGRAM_ID);
  }

  /**
   * Get the real SPL token balance in the token vault
   */
  async function getTokenVaultBalance(): Promise<BN> {
    try {
      const balance = await connection.getTokenAccountBalance(tokenVaultAddress);
      return new BN(balance.value.amount);
    } catch {
      return new BN(0);
    }
  }

  /**
   * Get user's SPL token balance for the game token
   */
  async function getUserTokenBalance(user: PublicKey): Promise<BN> {
    try {
      const state = await getGameState();
      if (!state) return new BN(0);
      const ata = getAssociatedTokenAddressSync(state.tokenMint, user, true, TOKEN_2022_PROGRAM_ID);
      const balance = await connection.getTokenAccountBalance(ata);
      return new BN(balance.value.amount);
    } catch {
      return new BN(0);
    }
  }

  /**
   * Convert Uint8Array to base64 string (browser-compatible)
   */
  function uint8ArrayToBase64(bytes: Uint8Array): string {
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
  }

  /**
   * Get all sold land IDs by fetching all LandData accounts
   */
  async function getAllSoldLandIds(): Promise<number[]> {
    try {
      const landDataDiscriminator = new Uint8Array([188, 85, 52, 43, 52, 142, 58, 79]);

      const accounts = await connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: uint8ArrayToBase64(landDataDiscriminator),
              encoding: "base64",
            },
          },
        ],
        dataSlice: {
          offset: 8, // Skip discriminator
          length: 2, // Only get land_id (u16)
        },
      });

      const landIds: number[] = [];
      for (const account of accounts) {
        const data = account.account.data;
        const landId = data[0] | (data[1] << 8); // u16 little-endian
        landIds.push(landId);
      }

      return landIds.sort((a, b) => a - b);
    } catch (error) {
      console.error("Failed to fetch all land IDs:", error);
      return [];
    }
  }

  /**
   * Get land IDs owned by a specific user.
   * Filters LandData accounts by owner field directly on-chain.
   */
  async function getUserLandIds(user: PublicKey): Promise<number[]> {
    try {
      const landDataDiscriminator = new Uint8Array([188, 85, 52, 43, 52, 142, 58, 79]);

      // LandData layout after discriminator:
      // land_id: u16 (2 bytes) at offset 8
      // owner: Pubkey (32 bytes) at offset 10
      const accounts = await connection.getProgramAccounts(programId, {
        filters: [
          {
            memcmp: {
              offset: 0,
              bytes: uint8ArrayToBase64(landDataDiscriminator),
              encoding: "base64",
            },
          },
          {
            memcmp: {
              offset: 10, // 8 (discriminator) + 2 (land_id)
              bytes: user.toBase58(),
            },
          },
        ],
        dataSlice: {
          offset: 8, // Skip discriminator
          length: 2, // Only get land_id (u16)
        },
      });

      const landIds: number[] = [];
      for (const account of accounts) {
        const data = account.account.data;
        const landId = data[0] | (data[1] << 8);
        landIds.push(landId);
      }

      return landIds.sort((a, b) => a - b);
    } catch (error) {
      console.error("Failed to fetch user land IDs:", error);
      return [];
    }
  }

  // ========== WRITE METHODS ==========

  async function initializeGame(): Promise<string> {
    if (!wallet) throw new Error("Wallet required");

    const tx = await program.methods
      .initializeGame()
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
        vault: vaultAddress,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  async function initTokenVault(): Promise<string> {
    if (!wallet) throw new Error("Wallet required");

    const state = await getGameState();
    if (!state) throw new Error("Game not initialized");

    const tx = await program.methods
      .initTokenVault()
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
        tokenMint: state.tokenMint,
        tokenVault: tokenVaultAddress,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  async function buyLand(landId: number): Promise<string> {
    if (!wallet) throw new Error("Wallet required");
    if (!isValidLandId(landId)) throw new Error("Invalid land ID (must be 1-21000)");

    const ctx = await getTokenContext();
    const [landDataAddress] = landDataPda(landId, programId);
    const [userProfileAddress] = userProfilePda(wallet.publicKey, programId);
    const userTokenAccount = getUserTokenAccountAddress(ctx.tokenMint, wallet.publicKey);

    const accounts = {
      user: wallet.publicKey,
      gameState: gameStateAddress,
      landData: landDataAddress,
      userProfile: userProfileAddress,
      tokenMint: ctx.tokenMint,
      userTokenAccount,
      tokenProgram: TOKEN_2022_PROGRAM_ID,
      systemProgram: SystemProgram.programId,
    };

    const ix = await program.methods
      .buyLand(landId)
      .accounts(accounts)
      .instruction();

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ix
    );
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signedTx = await wallet.signTransaction(tx);
    return sendAndConfirmTx(signedTx);
  }

  async function claimEarnings(landId: number): Promise<string> {
    if (!wallet) throw new Error("Wallet required");
    if (!isValidLandId(landId)) throw new Error("Invalid land ID (must be 1-21000)");

    const ctx = await getTokenContext();
    const [landDataAddress] = landDataPda(landId, programId);
    const userTokenAccount = getUserTokenAccountAddress(ctx.tokenMint, wallet.publicKey);

    const tx = await program.methods
      .claimEarnings(landId)
      .accounts({
        user: wallet.publicKey,
        gameState: gameStateAddress,
        landData: landDataAddress,
        tokenMint: ctx.tokenMint,
        tokenVault: ctx.tokenVaultAddress,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  /**
   * Build a claim instruction for a single land
   */
  async function buildClaimInstruction(
    landId: number,
    tokenCtx?: TokenContext
  ): Promise<TransactionInstruction> {
    if (!wallet) throw new Error("Wallet required");

    const ctx = tokenCtx || await getTokenContext();
    const [landDataAddress] = landDataPda(landId, programId);
    const userTokenAccount = getUserTokenAccountAddress(ctx.tokenMint, wallet.publicKey);

    return await program.methods
      .claimEarnings(landId)
      .accounts({
        user: wallet.publicKey,
        gameState: gameStateAddress,
        landData: landDataAddress,
        tokenMint: ctx.tokenMint,
        tokenVault: ctx.tokenVaultAddress,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .instruction();
  }

  /**
   * Claim earnings from multiple lands in batched transactions
   */
  async function claimAllEarnings(
    landIds: number[],
    onProgress?: BatchProgressCallback
  ): Promise<BatchClaimResult> {
    if (!wallet) throw new Error("Wallet required");
    if (landIds.length === 0) {
      return {
        successfulLandIds: [],
        failedLandIds: [],
        totalClaimed: new BN(0),
        txSignatures: [],
      };
    }

    // Fetch token context once for all batches
    const tokenCtx = await getTokenContext();

    // Capture pending earnings BEFORE claiming (after claim they reset to ~0)
    const pendingByLand = new Map<number, BN>();
    await Promise.all(
      landIds.map(async (landId) => {
        try {
          const pending = await getPendingEarnings(landId);
          pendingByLand.set(landId, pending);
        } catch {
          pendingByLand.set(landId, new BN(0));
        }
      })
    );

    // Split landIds into batches
    const batches: number[][] = [];
    for (let i = 0; i < landIds.length; i += MAX_CLAIMS_PER_TX) {
      batches.push(landIds.slice(i, i + MAX_CLAIMS_PER_TX));
    }

    const result: BatchClaimResult = {
      successfulLandIds: [],
      failedLandIds: [],
      totalClaimed: new BN(0),
      txSignatures: [],
    };

    let processedLands = 0;

    for (let batchIndex = 0; batchIndex < batches.length; batchIndex++) {
      const batch = batches[batchIndex];

      try {
        const instructions: TransactionInstruction[] = [];

        instructions.push(
          ComputeBudgetProgram.setComputeUnitLimit({
            units: Math.min(300_000 * batch.length, 1_400_000),
          })
        );

        for (const landId of batch) {
          try {
            const ix = await buildClaimInstruction(landId, tokenCtx);
            instructions.push(ix);
          } catch (err) {
            console.error(`Failed to build claim instruction for land ${landId}:`, err);
            result.failedLandIds.push(landId);
          }
        }

        if (instructions.length <= 1) {
          processedLands += batch.length;
          continue;
        }

        const tx = new Transaction().add(...instructions);
        const { blockhash } = await connection.getLatestBlockhash("confirmed");
        tx.recentBlockhash = blockhash;
        tx.feePayer = wallet.publicKey;

        const signedTx = await wallet.signTransaction(tx);
        const signature = await sendAndConfirmTx(signedTx);

        result.txSignatures.push(signature);

        for (const landId of batch) {
          if (!result.failedLandIds.includes(landId)) {
            result.successfulLandIds.push(landId);
          }
        }

        processedLands += batch.length;

        if (onProgress) {
          onProgress({
            currentBatch: batchIndex + 1,
            totalBatches: batches.length,
            processedLands,
            totalLands: landIds.length,
          });
        }
      } catch (err) {
        const isUserRejection =
          err instanceof Error &&
          (err.message.includes("User rejected") ||
            err.name === "WalletSignTransactionError");
        if (isUserRejection) {
          throw err;
        }

        console.error(`Batch ${batchIndex + 1} failed:`, err);
        for (const landId of batch) {
          if (!result.failedLandIds.includes(landId)) {
            result.failedLandIds.push(landId);
          }
        }
        processedLands += batch.length;

        if (onProgress) {
          onProgress({
            currentBatch: batchIndex + 1,
            totalBatches: batches.length,
            processedLands,
            totalLands: landIds.length,
          });
        }
      }
    }

    // Sum pre-fetched pending earnings for successfully claimed lands
    for (const landId of result.successfulLandIds) {
      const pending = pendingByLand.get(landId) ?? new BN(0);
      result.totalClaimed = result.totalClaimed.add(pending);
    }

    return result;
  }

  async function upgradeLand(landId: number): Promise<string> {
    if (!wallet) throw new Error("Wallet required");
    if (!isValidLandId(landId)) throw new Error("Invalid land ID (must be 1-21000)");

    const ctx = await getTokenContext();
    const [landDataAddress] = landDataPda(landId, programId);
    const userTokenAccount = getUserTokenAccountAddress(ctx.tokenMint, wallet.publicKey);

    const ix = await program.methods
      .upgradeLand(landId)
      .accounts({
        user: wallet.publicKey,
        gameState: gameStateAddress,
        landData: landDataAddress,
        tokenMint: ctx.tokenMint,
        userTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
      })
      .instruction();

    const tx = new Transaction().add(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 }),
      ix
    );
    const { blockhash } = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = blockhash;
    tx.feePayer = wallet.publicKey;

    const signedTx = await wallet.signTransaction(tx);
    return sendAndConfirmTx(signedTx);
  }

  async function withdrawSol(): Promise<string> {
    if (!wallet) throw new Error("Wallet required");

    const tx = await program.methods
      .withdrawSol()
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
        vault: vaultAddress,
      })
      .rpc();

    return tx;
  }

  async function withdrawTokens(): Promise<string> {
    if (!wallet) throw new Error("Wallet required");

    const ctx = await getTokenContext();
    const authorityTokenAccount = getUserTokenAccountAddress(ctx.tokenMint, wallet.publicKey);

    const tx = await program.methods
      .withdrawTokens()
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
        tokenMint: ctx.tokenMint,
        tokenVault: ctx.tokenVaultAddress,
        authorityTokenAccount,
        tokenProgram: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  async function setGameActive(isActive: boolean): Promise<string> {
    if (!wallet) throw new Error("Wallet required");

    const tx = await program.methods
      .setGameActive(isActive)
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
      })
      .rpc();

    return tx;
  }

  async function setTokenMint(newMint: PublicKey): Promise<string> {
    if (!wallet) throw new Error("Wallet required");

    const tx = await program.methods
      .setTokenMint(newMint)
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
      })
      .rpc();

    return tx;
  }

  async function migrateV2(): Promise<string> {
    if (!wallet) throw new Error("Wallet required");

    const tx = await program.methods
      .migrateV2()
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    return tx;
  }

  async function adminCloseLand(landId: number): Promise<string> {
    if (!wallet) throw new Error("Wallet required");
    if (!isValidLandId(landId)) throw new Error("Invalid land ID (must be 1-21000)");

    const [landDataAddress] = landDataPda(landId, programId);
    const landData = await getLandData(landId);
    if (!landData) throw new Error(`Land #${landId} not found`);

    const [userProfileAddress] = userProfilePda(landData.owner, programId);

    const tx = await program.methods
      .adminCloseLand(landId)
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
        landData: landDataAddress,
        userProfile: userProfileAddress,
      })
      .rpc();

    return tx;
  }

  async function adminCloseUserProfile(userPubkey: PublicKey): Promise<string> {
    if (!wallet) throw new Error("Wallet required");

    const [userProfileAddress] = userProfilePda(userPubkey, programId);

    const tx = await program.methods
      .adminCloseUserProfile()
      .accounts({
        authority: wallet.publicKey,
        gameState: gameStateAddress,
        userProfile: userProfileAddress,
      })
      .rpc();

    return tx;
  }

  return {
    // Program
    program,
    provider,
    programId,

    // Addresses
    gameStateAddress,
    vaultAddress,
    tokenVaultAddress,
    getLandDataAddress: (landId: number) => landDataPda(landId, programId)[0],
    getUserProfileAddress: (user: PublicKey) => userProfilePda(user, programId)[0],
    getUserTokenAccountAddress,

    // Read methods
    getGameState,
    getLandData,
    isLandOwned,
    isLandOwnedBy,
    getVaultBalance,
    getTokenVaultBalance,
    getUserTokenBalance,
    isGameInitialized,
    getPendingEarnings,
    getUserProfile,
    getUserLandCount,
    getAllSoldLandIds,
    getUserLandIds,

    // Write methods
    initializeGame,
    initTokenVault,
    buyLand,
    claimEarnings,
    claimAllEarnings,
    upgradeLand,
    withdrawSol,
    withdrawTokens,
    setGameActive,
    setTokenMint,
    migrateV2,
    adminCloseLand,
    adminCloseUserProfile,

    // Helpers
    calculateEarnings,
    getUpgradeCost,
    getEarningSpeed,
    isValidLandId,
  };
}

export type ColonyClient = ReturnType<typeof createColonyClient>;
