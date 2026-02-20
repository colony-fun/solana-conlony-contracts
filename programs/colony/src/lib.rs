use anchor_lang::prelude::*;
use anchor_lang::system_program;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token_interface::{Mint, TokenAccount, TokenInterface, TransferChecked, BurnChecked, transfer_checked, burn_checked};

declare_id!("BCVGJ5YoKMftBrt5fgDYhtvY7HVBccFofFiGqJtoRjqE");

// ============================================================================
// CONSTANTS
// ============================================================================

/// Game token mint ($OLO on pump.fun)
pub const GAME_TOKEN_MINT: Pubkey = pubkey!("2pXjxbdHnYWtH2gtDN495Ve1jm8bs1zoUL6XsUi3pump");

/// Land price in tokens (10,000 tokens, burned on purchase)
pub const LAND_PRICE_TOKENS: u64 = 10_000 * TOKEN_MULTIPLIER;

/// Maximum land ID (21000 lands total, matching Mars globe grid)
pub const MAX_LAND_ID: u16 = 21000;

/// Maximum lands per wallet
pub const MAX_LANDS_PER_USER: u8 = 10;

/// Maximum land level
pub const MAX_LEVEL: u8 = 10;

/// Token decimals
pub const TOKEN_DECIMALS: u8 = 6;

/// Multiplier for token amounts (10^6)
pub const TOKEN_MULTIPLIER: u64 = 1_000_000;

/// Upgrade costs in tokens (level 2-10)
pub const UPGRADE_COSTS: [u64; 9] = [
    1_000 * TOKEN_MULTIPLIER,   // 1 → 2
    2_000 * TOKEN_MULTIPLIER,   // 2 → 3
    4_000 * TOKEN_MULTIPLIER,   // 3 → 4
    8_000 * TOKEN_MULTIPLIER,   // 4 → 5
    16_000 * TOKEN_MULTIPLIER,  // 5 → 6
    32_000 * TOKEN_MULTIPLIER,  // 6 → 7
    64_000 * TOKEN_MULTIPLIER,  // 7 → 8
    128_000 * TOKEN_MULTIPLIER, // 8 → 9
    152_000 * TOKEN_MULTIPLIER, // 9 → 10
];

/// Earning speeds in tokens per day (level 1-10)
pub const EARNING_SPEEDS: [u64; 10] = [
    1_000 * TOKEN_MULTIPLIER,  // Level 1
    2_000 * TOKEN_MULTIPLIER,  // Level 2
    3_000 * TOKEN_MULTIPLIER,  // Level 3
    5_000 * TOKEN_MULTIPLIER,  // Level 4
    8_000 * TOKEN_MULTIPLIER,  // Level 5
    13_000 * TOKEN_MULTIPLIER, // Level 6
    21_000 * TOKEN_MULTIPLIER, // Level 7
    34_000 * TOKEN_MULTIPLIER, // Level 8
    45_000 * TOKEN_MULTIPLIER, // Level 9
    79_000 * TOKEN_MULTIPLIER, // Level 10
];

/// Seconds per day
pub const SECONDS_PER_DAY: u64 = 86400;

/// Mining launch time: 2026-02-17 16:00 CET
pub const MINING_START_TIME: i64 = 1771340400;

// ============================================================================
// PROGRAM
// ============================================================================

#[program]
pub mod colony {
    use super::*;

    /// Initialize the game state (call once)
    pub fn initialize_game(ctx: Context<InitializeGame>) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.authority = ctx.accounts.authority.key();
        game_state.treasury_balance = 0;
        game_state.total_lands_sold = 0;
        game_state.total_sol_collected = 0;
        game_state.is_active = true;
        game_state.bump = ctx.bumps.game_state;
        game_state.vault_bump = ctx.bumps.vault;
        game_state.token_mint = GAME_TOKEN_MINT;
        game_state.token_vault_bump = 0;

        msg!("Game initialized by: {}", game_state.authority);
        Ok(())
    }

    /// Buy a land plot
    pub fn buy_land(ctx: Context<BuyLand>, land_id: u16) -> Result<()> {
        require!(ctx.accounts.game_state.is_active, ColonyError::GameNotActive);
        require!(land_id > 0 && land_id <= MAX_LAND_ID, ColonyError::InvalidLandId);
        require!(
            ctx.accounts.user_profile.lands_owned < MAX_LANDS_PER_USER,
            ColonyError::MaxLandsReached
        );

        // Burn tokens from user (payment for land)
        burn_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                BurnChecked {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    from: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            LAND_PRICE_TOKENS,
            TOKEN_DECIMALS,
        )?;

        // Initialize land data
        let land_data = &mut ctx.accounts.land_data;
        land_data.land_id = land_id;
        land_data.owner = ctx.accounts.user.key();
        land_data.level = 1;
        land_data.fixed_earnings = 0;
        land_data.last_checkout = if Clock::get()?.unix_timestamp < MINING_START_TIME {
            MINING_START_TIME
        } else {
            Clock::get()?.unix_timestamp
        };
        land_data.bump = ctx.bumps.land_data;

        // Update user profile
        let user_profile = &mut ctx.accounts.user_profile;
        user_profile.owner = ctx.accounts.user.key();
        user_profile.lands_owned = user_profile
            .lands_owned
            .checked_add(1)
            .ok_or(ColonyError::Overflow)?;
        user_profile.bump = ctx.bumps.user_profile;

        // Update game state
        let game_state = &mut ctx.accounts.game_state;
        game_state.total_lands_sold = game_state
            .total_lands_sold
            .checked_add(1)
            .ok_or(ColonyError::Overflow)?;

        msg!("User {} bought land #{}", ctx.accounts.user.key(), land_id);
        Ok(())
    }

    /// Claim earnings from a specific land (transfers real SPL tokens to user)
    pub fn claim_earnings(ctx: Context<ClaimEarnings>, _land_id: u16) -> Result<()> {
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= MINING_START_TIME, ColonyError::MiningNotStarted);

        let land_data = &ctx.accounts.land_data;
        require!(land_data.owner == ctx.accounts.user.key(), ColonyError::NotLandOwner);

        let earnings = calculate_earnings(land_data, clock.unix_timestamp)?;
        require!(earnings > 0, ColonyError::NoEarnings);

        // Check token vault has enough real tokens
        require!(
            ctx.accounts.token_vault.amount >= earnings,
            ColonyError::InsufficientTreasury
        );

        // Transfer real SPL tokens from vault to user
        let bump = ctx.accounts.game_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"game_state", &[bump]]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.game_state.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                },
                signer_seeds,
            ),
            earnings,
            TOKEN_DECIMALS,
        )?;

        // Update land data
        let land_data = &mut ctx.accounts.land_data;
        land_data.fixed_earnings = 0;
        land_data.last_checkout = clock.unix_timestamp;

        msg!("Claimed {} tokens from land #{}", earnings, land_data.land_id);
        Ok(())
    }

    /// Upgrade a land to the next level (user pays real SPL tokens)
    pub fn upgrade_land(ctx: Context<UpgradeLand>, _land_id: u16) -> Result<()> {
        let clock = Clock::get()?;
        require!(clock.unix_timestamp >= MINING_START_TIME, ColonyError::MiningNotStarted);

        let land_data = &ctx.accounts.land_data;
        require!(land_data.owner == ctx.accounts.user.key(), ColonyError::NotLandOwner);
        require!(land_data.level < MAX_LEVEL, ColonyError::MaxLevelReached);

        let pending = calculate_earnings(land_data, clock.unix_timestamp)?;
        let cost = UPGRADE_COSTS[(land_data.level - 1) as usize];

        // Check user has enough real tokens
        require!(
            ctx.accounts.user_token_account.amount >= cost,
            ColonyError::InsufficientBalance
        );

        // Burn tokens from user (upgrade cost)
        burn_checked(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                BurnChecked {
                    mint: ctx.accounts.token_mint.to_account_info(),
                    from: ctx.accounts.user_token_account.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            cost,
            TOKEN_DECIMALS,
        )?;

        // Upgrade land
        let land_data = &mut ctx.accounts.land_data;
        land_data.fixed_earnings = pending;
        land_data.last_checkout = clock.unix_timestamp;
        land_data.level += 1;

        msg!("Land #{} upgraded to level {}", land_data.land_id, land_data.level);
        Ok(())
    }

    /// Initialize the token vault PDA (owner only, call after set_token_mint)
    pub fn init_token_vault(ctx: Context<InitTokenVault>) -> Result<()> {
        require!(
            ctx.accounts.game_state.token_mint != Pubkey::default(),
            ColonyError::TokenMintNotSet
        );

        let game_state = &mut ctx.accounts.game_state;
        game_state.token_vault_bump = ctx.bumps.token_vault;

        msg!("Token vault initialized for mint: {}", game_state.token_mint);
        Ok(())
    }

    /// Withdraw all SOL from vault (owner only)
    pub fn withdraw_sol(ctx: Context<WithdrawSol>) -> Result<()> {
        let amount = ctx.accounts.vault.lamports();
        require!(amount > 0, ColonyError::InsufficientBalance);

        let bump = ctx.accounts.game_state.vault_bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"vault", &[bump]]];

        system_program::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.system_program.to_account_info(),
                system_program::Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.authority.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
        )?;

        msg!("Withdrawn {} lamports to authority", amount);
        Ok(())
    }

    /// Withdraw all SPL tokens from token vault to authority (owner only)
    pub fn withdraw_tokens(ctx: Context<WithdrawTokens>) -> Result<()> {
        let amount = ctx.accounts.token_vault.amount;
        require!(amount > 0, ColonyError::InsufficientBalance);

        let bump = ctx.accounts.game_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"game_state", &[bump]]];

        transfer_checked(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                TransferChecked {
                    from: ctx.accounts.token_vault.to_account_info(),
                    to: ctx.accounts.authority_token_account.to_account_info(),
                    authority: ctx.accounts.game_state.to_account_info(),
                    mint: ctx.accounts.token_mint.to_account_info(),
                },
                signer_seeds,
            ),
            amount,
            TOKEN_DECIMALS,
        )?;

        msg!("Withdrawn {} tokens to authority", amount);
        Ok(())
    }

    /// Close the token vault account (owner only, for re-initialization with new mint)
    pub fn admin_close_token_vault(ctx: Context<AdminCloseTokenVault>) -> Result<()> {
        let bump = ctx.accounts.game_state.bump;
        let signer_seeds: &[&[&[u8]]] = &[&[b"game_state", &[bump]]];

        anchor_spl::token_interface::close_account(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                anchor_spl::token_interface::CloseAccount {
                    account: ctx.accounts.token_vault.to_account_info(),
                    destination: ctx.accounts.authority.to_account_info(),
                    authority: ctx.accounts.game_state.to_account_info(),
                },
                signer_seeds,
            ),
        )?;

        ctx.accounts.game_state.token_vault_bump = 0;
        msg!("Token vault closed");
        Ok(())
    }

    /// Pause/unpause the game (owner only)
    pub fn set_game_active(ctx: Context<AdminAction>, is_active: bool) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.is_active = is_active;
        msg!("Game active status: {}", is_active);
        Ok(())
    }

    /// Set the token mint address (owner only)
    pub fn set_token_mint(ctx: Context<AdminAction>, new_mint: Pubkey) -> Result<()> {
        let game_state = &mut ctx.accounts.game_state;
        game_state.token_mint = new_mint;
        msg!("Token mint updated to: {}", new_mint);
        Ok(())
    }

    /// One-time migration to extend GameState (owner only)
    pub fn migrate_v2(ctx: Context<MigrateV2>) -> Result<()> {
        let game_state = &ctx.accounts.game_state;

        // Verify authority from raw bytes (offset 8, 32 bytes)
        let data = game_state.try_borrow_data()?;
        let stored_authority = Pubkey::try_from(&data[8..40])
            .map_err(|_| ColonyError::Unauthorized)?;
        require!(
            ctx.accounts.authority.key() == stored_authority,
            ColonyError::Unauthorized
        );
        let current_len = data.len();
        drop(data);

        let new_len = 8 + GameState::INIT_SPACE;

        if current_len >= new_len {
            msg!("GameState already at correct size ({})", current_len);
            return Ok(());
        }

        // Transfer additional rent from authority
        let rent = Rent::get()?;
        let new_minimum_balance = rent.minimum_balance(new_len);
        let current_balance = game_state.lamports();
        let additional_rent = new_minimum_balance.saturating_sub(current_balance);

        if additional_rent > 0 {
            system_program::transfer(
                CpiContext::new(
                    ctx.accounts.system_program.to_account_info(),
                    system_program::Transfer {
                        from: ctx.accounts.authority.to_account_info(),
                        to: game_state.to_account_info(),
                    },
                ),
                additional_rent,
            )?;
        }

        // Realloc (zero = false, new bytes are zero-initialized which means Pubkey::default())
        #[allow(deprecated)]
        game_state.realloc(new_len, false)?;

        msg!(
            "GameState migrated from {} to {} bytes",
            current_len,
            new_len
        );
        Ok(())
    }

    /// Close a land account and return rent to authority (admin only)
    pub fn admin_close_land(ctx: Context<AdminCloseLand>, _land_id: u16) -> Result<()> {
        // Decrement user's lands_owned
        let user_profile = &mut ctx.accounts.user_profile;
        user_profile.lands_owned = user_profile
            .lands_owned
            .checked_sub(1)
            .ok_or(ColonyError::Overflow)?;

        // Decrement game_state.total_lands_sold
        let game_state = &mut ctx.accounts.game_state;
        game_state.total_lands_sold = game_state
            .total_lands_sold
            .checked_sub(1)
            .ok_or(ColonyError::Overflow)?;

        msg!("Land #{} closed by admin", ctx.accounts.land_data.land_id);
        Ok(())
        // land_data account is closed by Anchor's `close = authority` constraint
    }

    /// Close a user profile account and return rent to authority (admin only)
    pub fn admin_close_user_profile(ctx: Context<AdminCloseUserProfile>) -> Result<()> {
        require!(
            ctx.accounts.user_profile.lands_owned == 0,
            ColonyError::UserHasLands
        );

        msg!("User profile closed for {}", ctx.accounts.user_profile.owner);
        Ok(())
        // user_profile account is closed by Anchor's `close = authority` constraint
    }

    /// Get pending earnings for a land (view function via simulate)
    pub fn get_pending_earnings(ctx: Context<GetPendingEarnings>, _land_id: u16) -> Result<u64> {
        let land_data = &ctx.accounts.land_data;
        let clock = Clock::get()?;
        let earnings = calculate_earnings(land_data, clock.unix_timestamp)?;
        msg!("Pending earnings: {}", earnings);
        Ok(earnings)
    }
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

fn calculate_earnings(land: &LandData, current_time: i64) -> Result<u64> {
    if current_time < MINING_START_TIME {
        return Ok(land.fixed_earnings);
    }

    let time_passed = (current_time - land.last_checkout) as u64;
    let speed = EARNING_SPEEDS[(land.level - 1) as usize];

    let earned = speed
        .checked_mul(time_passed)
        .ok_or(ColonyError::Overflow)?
        .checked_div(SECONDS_PER_DAY)
        .ok_or(ColonyError::Overflow)?
        .checked_add(land.fixed_earnings)
        .ok_or(ColonyError::Overflow)?;

    Ok(earned)
}

// ============================================================================
// ACCOUNTS
// ============================================================================

#[derive(Accounts)]
pub struct InitializeGame<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        init,
        payer = authority,
        space = 8 + GameState::INIT_SPACE,
        seeds = [b"game_state"],
        bump
    )]
    pub game_state: Account<'info, GameState>,

    /// CHECK: Vault PDA that holds SOL
    #[account(
        mut,
        seeds = [b"vault"],
        bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(land_id: u16)]
pub struct BuyLand<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    #[account(
        init,
        payer = user,
        space = 8 + LandData::INIT_SPACE,
        seeds = [b"land_data", land_id.to_le_bytes().as_ref()],
        bump
    )]
    pub land_data: Account<'info, LandData>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + UserProfile::INIT_SPACE,
        seeds = [b"user_profile", user.key().as_ref()],
        bump
    )]
    pub user_profile: Account<'info, UserProfile>,

    #[account(
        mut,
        constraint = token_mint.key() == game_state.token_mint @ ColonyError::InvalidTokenMint
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(land_id: u16)]
pub struct ClaimEarnings<'info> {
    #[account(mut)]
    pub user: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [b"land_data", land_id.to_le_bytes().as_ref()],
        bump = land_data.bump
    )]
    pub land_data: Account<'info, LandData>,

    #[account(
        constraint = token_mint.key() == game_state.token_mint @ ColonyError::InvalidTokenMint
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = game_state,
        seeds = [b"token_vault"],
        bump = game_state.token_vault_bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = user,
        associated_token::mint = token_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(land_id: u16)]
pub struct UpgradeLand<'info> {
    pub user: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [b"land_data", land_id.to_le_bytes().as_ref()],
        bump = land_data.bump
    )]
    pub land_data: Account<'info, LandData>,

    #[account(
        mut,
        constraint = token_mint.key() == game_state.token_mint @ ColonyError::InvalidTokenMint
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        associated_token::mint = token_mint,
        associated_token::authority = user,
        associated_token::token_program = token_program,
    )]
    pub user_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct InitTokenVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    #[account(
        mut,
        constraint = authority.key() == game_state.authority @ ColonyError::Unauthorized
    )]
    pub game_state: Account<'info, GameState>,

    #[account(
        constraint = token_mint.key() == game_state.token_mint @ ColonyError::InvalidTokenMint
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        init,
        payer = authority,
        token::mint = token_mint,
        token::authority = game_state,
        seeds = [b"token_vault"],
        bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawSol<'info> {
    #[account(
        mut,
        constraint = authority.key() == game_state.authority @ ColonyError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    /// CHECK: Vault PDA that holds SOL
    #[account(
        mut,
        seeds = [b"vault"],
        bump = game_state.vault_bump
    )]
    pub vault: SystemAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawTokens<'info> {
    #[account(
        mut,
        constraint = authority.key() == game_state.authority @ ColonyError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    #[account(
        constraint = token_mint.key() == game_state.token_mint @ ColonyError::InvalidTokenMint
    )]
    pub token_mint: InterfaceAccount<'info, Mint>,

    #[account(
        mut,
        token::mint = token_mint,
        token::authority = game_state,
        seeds = [b"token_vault"],
        bump = game_state.token_vault_bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = token_mint,
        associated_token::authority = authority,
        associated_token::token_program = token_program,
    )]
    pub authority_token_account: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminCloseTokenVault<'info> {
    #[account(
        mut,
        constraint = authority.key() == game_state.authority @ ColonyError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    #[account(
        mut,
        token::authority = game_state,
        seeds = [b"token_vault"],
        bump = game_state.token_vault_bump
    )]
    pub token_vault: InterfaceAccount<'info, TokenAccount>,

    pub token_program: Interface<'info, TokenInterface>,
}

#[derive(Accounts)]
pub struct AdminAction<'info> {
    #[account(
        constraint = authority.key() == game_state.authority @ ColonyError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,
}

#[derive(Accounts)]
pub struct MigrateV2<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,

    /// CHECK: Manual authority validation during migration (account may have old layout)
    #[account(
        mut,
        seeds = [b"game_state"],
        bump,
    )]
    pub game_state: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(land_id: u16)]
pub struct AdminCloseLand<'info> {
    #[account(
        mut,
        constraint = authority.key() == game_state.authority @ ColonyError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [b"land_data", land_id.to_le_bytes().as_ref()],
        bump = land_data.bump,
        close = authority
    )]
    pub land_data: Account<'info, LandData>,

    #[account(
        mut,
        seeds = [b"user_profile", land_data.owner.as_ref()],
        bump = user_profile.bump
    )]
    pub user_profile: Account<'info, UserProfile>,
}

#[derive(Accounts)]
pub struct AdminCloseUserProfile<'info> {
    #[account(
        mut,
        constraint = authority.key() == game_state.authority @ ColonyError::Unauthorized
    )]
    pub authority: Signer<'info>,

    #[account(mut)]
    pub game_state: Account<'info, GameState>,

    #[account(
        mut,
        seeds = [b"user_profile", user_profile.owner.as_ref()],
        bump = user_profile.bump,
        close = authority
    )]
    pub user_profile: Account<'info, UserProfile>,
}

#[derive(Accounts)]
#[instruction(land_id: u16)]
pub struct GetPendingEarnings<'info> {
    #[account(
        seeds = [b"land_data", land_id.to_le_bytes().as_ref()],
        bump = land_data.bump
    )]
    pub land_data: Account<'info, LandData>,
}

// ============================================================================
// STATE
// ============================================================================

#[account]
#[derive(InitSpace)]
pub struct GameState {
    pub authority: Pubkey,        // 32 bytes
    pub treasury_balance: u64,    // 8 bytes - DEPRECATED: unused, kept for account layout compatibility
    pub total_lands_sold: u64,    // 8 bytes
    pub total_sol_collected: u64, // 8 bytes
    pub is_active: bool,          // 1 byte
    pub bump: u8,                 // 1 byte
    pub vault_bump: u8,           // 1 byte
    pub token_mint: Pubkey,       // 32 bytes - associated SPL token mint
    pub token_vault_bump: u8,     // 1 byte - token vault PDA bump
}

#[account]
#[derive(InitSpace)]
pub struct LandData {
    pub land_id: u16,         // 2 bytes
    pub owner: Pubkey,        // 32 bytes - land owner wallet
    pub level: u8,            // 1 byte (1-10)
    pub fixed_earnings: u64,  // 8 bytes
    pub last_checkout: i64,   // 8 bytes
    pub bump: u8,             // 1 byte
}

#[account]
#[derive(InitSpace)]
pub struct UserProfile {
    pub owner: Pubkey,        // 32 bytes
    pub lands_owned: u8,      // 1 byte
    pub token_balance: u64,   // 8 bytes - legacy internal balance (unused with SPL tokens)
    pub bump: u8,             // 1 byte
}

// ============================================================================
// ERRORS
// ============================================================================

#[error_code]
pub enum ColonyError {
    #[msg("Amount must be greater than zero")]
    InvalidAmount,
    #[msg("Arithmetic overflow")]
    Overflow,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Game is not active")]
    GameNotActive,
    #[msg("Invalid land ID (must be 1-21000)")]
    InvalidLandId,
    #[msg("Land is already at maximum level")]
    MaxLevelReached,
    #[msg("No earnings to claim")]
    NoEarnings,
    #[msg("Insufficient tokens in treasury")]
    InsufficientTreasury,
    #[msg("Insufficient balance")]
    InsufficientBalance,
    #[msg("You don't own this land")]
    NotLandOwner,
    #[msg("Maximum lands per user reached")]
    MaxLandsReached,
    #[msg("Mining has not started yet")]
    MiningNotStarted,
    #[msg("Token mint not set")]
    TokenMintNotSet,
    #[msg("Invalid token mint")]
    InvalidTokenMint,
    #[msg("User still has lands owned")]
    UserHasLands,
}
