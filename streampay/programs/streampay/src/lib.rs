use anchor_lang::prelude::*;
use std::mem::size_of;

declare_id!("jQrBRLbEtgwUdvcaetiWJJR3HztTEkER3W2tC8A4Vt3");

// Constants - keeping these organized at the top
const COMPANY_SEED: &[u8] = b"company";
const EMPLOYEE_SEED: &[u8] = b"employee";
const WORK_SESSION_SEED: &[u8] = b"work_session";
const SECONDS_PER_HOUR: i64 = 3600;

#[program]
pub mod streampay {
    use super::*;

    /// Initialize a new company account
    /// This is where companies get onboarded to StreamPay
    pub fn initialize_company(
        ctx: Context<InitializeCompany>,
        company_name: String,
    ) -> Result<()> {
        let company = &mut ctx.accounts.company;
        let owner = ctx.accounts.owner.key();
        
        // Basic validation - companies need names!
        require!(company_name.len() > 0, StreamPayError::InvalidCompanyName);
        require!(company_name.len() <= 32, StreamPayError::CompanyNameTooLong);

        company.owner = owner;
        company.total_deposited = 0;
        company.employee_count = 0;
        company.company_name = company_name.clone();
        company.created_at = Clock::get()?.unix_timestamp;

        emit!(CompanyInitialized {
            company: company.key(),
            owner,
            company_name,
            timestamp: company.created_at,
        });

        msg!("Company '{}' initialized successfully!", company_name);
        Ok(())
    }

    /// Add a new employee to the company
    /// Only company owners can do this
    pub fn add_employee(
        ctx: Context<AddEmployee>,
        hourly_rate: u64, // in lamports per hour
    ) -> Result<()> {
        let company = &mut ctx.accounts.company;
        let employee_account = &mut ctx.accounts.employee_account;
        let employee_pubkey = ctx.accounts.employee.key();

        // Validate hourly rate - can't be working for free!
        require!(hourly_rate > 0, StreamPayError::InvalidHourlyRate);
        
        // Set up the employee account
        employee_account.company = company.key();
        employee_account.employee = employee_pubkey;
        employee_account.hourly_rate = hourly_rate;
        employee_account.total_hours_worked = 0;
        employee_account.last_clock_in = 0;
        employee_account.is_clocked_in = false;
        employee_account.total_withdrawn = 0;
        employee_account.total_earned = 0;
        employee_account.created_at = Clock::get()?.unix_timestamp;

        // Update company stats
        company.employee_count = company.employee_count.checked_add(1)
            .ok_or(StreamPayError::Overflow)?;

        emit!(EmployeeAdded {
            company: company.key(),
            employee: employee_pubkey,
            hourly_rate,
            timestamp: employee_account.created_at,
        });

        msg!("Employee {} added with hourly rate: {} lamports", 
             employee_pubkey, hourly_rate);
        Ok(())
    }

    /// Company deposits funds for payroll
    /// This increases the company's available balance for paying employees
    pub fn deposit_payroll(
        ctx: Context<DepositPayroll>,
        amount: u64,
    ) -> Result<()> {
        let company = &mut ctx.accounts.company;
        
        require!(amount > 0, StreamPayError::InvalidDepositAmount);

        // Transfer SOL from owner to company PDA
        let cpi_context = CpiContext::new(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: ctx.accounts.owner.to_account_info(),
                to: ctx.accounts.company.to_account_info(),
            },
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        company.total_deposited = company.total_deposited.checked_add(amount)
            .ok_or(StreamPayError::Overflow)?;

        emit!(PayrollDeposited {
            company: company.key(),
            owner: ctx.accounts.owner.key(),
            amount,
            new_balance: company.total_deposited,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Deposited {} lamports to company payroll", amount);
        Ok(())
    }

    /// Employee clocks in to start a work session
    pub fn clock_in(ctx: Context<ClockIn>) -> Result<()> {
        let employee_account = &mut ctx.accounts.employee_account;
        let work_session = &mut ctx.accounts.work_session;
        let current_time = Clock::get()?.unix_timestamp;

        // Can't clock in if already clocked in - basic validation
        require!(!employee_account.is_clocked_in, StreamPayError::AlreadyClockedIn);

        // Initialize work session
        work_session.employee = employee_account.employee;
        work_session.clock_in_time = current_time;
        work_session.clock_out_time = 0; // Not clocked out yet
        work_session.hours_worked = 0;
        work_session.amount_earned = 0;
        work_session.session_id = employee_account.total_sessions_count;

        // Update employee status
        employee_account.is_clocked_in = true;
        employee_account.last_clock_in = current_time;
        employee_account.total_sessions_count = employee_account.total_sessions_count
            .checked_add(1).ok_or(StreamPayError::Overflow)?;

        emit!(EmployeeClockedIn {
            employee: employee_account.employee,
            company: employee_account.company,
            clock_in_time: current_time,
            session_id: work_session.session_id,
        });

        msg!("Employee {} clocked in at {}", employee_account.employee, current_time);
        Ok(())
    }

    /// Employee clocks out and calculates earnings for the session
    pub fn clock_out(ctx: Context<ClockOut>) -> Result<()> {
        let employee_account = &mut ctx.accounts.employee_account;
        let work_session = &mut ctx.accounts.work_session;
        let current_time = Clock::get()?.unix_timestamp;

        // Must be clocked in to clock out
        require!(employee_account.is_clocked_in, StreamPayError::NotClockedIn);

        let clock_in_time = work_session.clock_in_time;
        require!(current_time > clock_in_time, StreamPayError::InvalidClockOutTime);

        // Calculate work duration and earnings
        let work_duration = current_time - clock_in_time;
        let hours_worked_decimal = work_duration as f64 / SECONDS_PER_HOUR as f64;
        
        // Round to 2 decimal places for hours (stored as integer with 2 decimal precision)
        let hours_worked = (hours_worked_decimal * 100.0).round() as u64;
        let amount_earned = calculate_earnings(employee_account.hourly_rate, hours_worked)?;

        // Update work session
        work_session.clock_out_time = current_time;
        work_session.hours_worked = hours_worked;
        work_session.amount_earned = amount_earned;

        // Update employee totals
        employee_account.is_clocked_in = false;
        employee_account.total_hours_worked = employee_account.total_hours_worked
            .checked_add(hours_worked).ok_or(StreamPayError::Overflow)?;
        employee_account.total_earned = employee_account.total_earned
            .checked_add(amount_earned).ok_or(StreamPayError::Overflow)?;

        emit!(EmployeeClockedOut {
            employee: employee_account.employee,
            company: employee_account.company,
            clock_out_time: current_time,
            hours_worked,
            amount_earned,
            session_id: work_session.session_id,
        });

        msg!("Employee {} clocked out. Worked {:.2} hours, earned {} lamports",
             employee_account.employee, hours_worked_decimal, amount_earned);
        Ok(())
    }

    /// Employee withdraws their earned balance
    pub fn withdraw_earnings(
        ctx: Context<WithdrawEarnings>,
        amount: u64,
    ) -> Result<()> {
        let employee_account = &mut ctx.accounts.employee_account;
        let company = &ctx.accounts.company;

        require!(amount > 0, StreamPayError::InvalidWithdrawAmount);
        
        // Calculate available balance
        let available_balance = employee_account.total_earned
            .checked_sub(employee_account.total_withdrawn)
            .ok_or(StreamPayError::InsufficientBalance)?;

        require!(amount <= available_balance, StreamPayError::InsufficientBalance);

        // Company PDA transfers SOL to employee
        let company_key = company.key();
        let seeds = &[
            COMPANY_SEED,
            company.owner.as_ref(),
            &[ctx.bumps.company]
        ];
        let signer = &[&seeds[..]];

        let cpi_context = CpiContext::new_with_signer(
            ctx.accounts.system_program.to_account_info(),
            anchor_lang::system_program::Transfer {
                from: company.to_account_info(),
                to: ctx.accounts.employee.to_account_info(),
            },
            signer,
        );
        anchor_lang::system_program::transfer(cpi_context, amount)?;

        // Update employee records
        employee_account.total_withdrawn = employee_account.total_withdrawn
            .checked_add(amount).ok_or(StreamPayError::Overflow)?;

        emit!(EarningsWithdrawn {
            employee: employee_account.employee,
            company: company_key,
            amount,
            remaining_balance: available_balance - amount,
            timestamp: Clock::get()?.unix_timestamp,
        });

        msg!("Employee {} withdrew {} lamports", employee_account.employee, amount);
        Ok(())
    }

    /// View function to get available balance (doesn't modify state)
    /// This is a helper for frontends
    pub fn get_available_balance(
        ctx: Context<GetAvailableBalance>,
    ) -> Result<u64> {
        let employee_account = &ctx.accounts.employee_account;
        
        let available = employee_account.total_earned
            .checked_sub(employee_account.total_withdrawn)
            .ok_or(StreamPayError::InsufficientBalance)?;

        msg!("Available balance for {}: {} lamports", 
             employee_account.employee, available);
        Ok(available)
    }
}

// Helper function for earnings calculation
fn calculate_earnings(hourly_rate: u64, hours_worked_centihours: u64) -> Result<u64> {
    // hours_worked_centihours is in centihours (1/100th of an hour)
    let earnings = (hourly_rate as u128)
        .checked_mul(hours_worked_centihours as u128)
        .and_then(|result| result.checked_div(100))
        .and_then(|result| u64::try_from(result).ok())
        .ok_or(StreamPayError::Overflow)?;
    
    Ok(earnings)
}

// ==================== ACCOUNT STRUCTURES ====================

#[account]
pub struct Company {
    pub owner: Pubkey,           // 32 bytes
    pub total_deposited: u64,    // 8 bytes
    pub employee_count: u32,     // 4 bytes  
    pub company_name: String,    // 4 + up to 32 bytes
    pub created_at: i64,         // 8 bytes
    // Total: ~88 bytes + string overhead
}

#[account]
pub struct Employee {
    pub company: Pubkey,          // 32 bytes
    pub employee: Pubkey,         // 32 bytes
    pub hourly_rate: u64,         // 8 bytes (lamports per hour)
    pub total_hours_worked: u64,  // 8 bytes (in centihours for precision)
    pub last_clock_in: i64,       // 8 bytes (unix timestamp)
    pub is_clocked_in: bool,      // 1 byte
    pub total_withdrawn: u64,     // 8 bytes
    pub total_earned: u64,        // 8 bytes
    pub created_at: i64,          // 8 bytes
    pub total_sessions_count: u64, // 8 bytes - for generating unique session IDs
    // Total: ~121 bytes
}

#[account]
pub struct WorkSession {
    pub employee: Pubkey,       // 32 bytes
    pub clock_in_time: i64,     // 8 bytes
    pub clock_out_time: i64,    // 8 bytes
    pub hours_worked: u64,      // 8 bytes (in centihours)
    pub amount_earned: u64,     // 8 bytes
    pub session_id: u64,        // 8 bytes
    // Total: 72 bytes
}

// ==================== CONTEXT STRUCTS ====================

#[derive(Accounts)]
#[instruction(company_name: String)]
pub struct InitializeCompany<'info> {
    #[account(
        init,
        payer = owner,
        space = 8 + size_of::<Company>() + 4 + 32, // discriminator + struct + string vec + max string
        seeds = [COMPANY_SEED, owner.key().as_ref()],
        bump
    )]
    pub company: Account<'info, Company>,
    
    #[account(mut)]
    pub owner: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AddEmployee<'info> {
    #[account(
        mut,
        seeds = [COMPANY_SEED, company.owner.as_ref()],
        bump,
        has_one = owner @ StreamPayError::UnauthorizedCompanyAccess
    )]
    pub company: Account<'info, Company>,
    
    #[account(
        init,
        payer = owner,
        space = 8 + size_of::<Employee>(),
        seeds = [EMPLOYEE_SEED, company.key().as_ref(), employee.key().as_ref()],
        bump
    )]
    pub employee_account: Account<'info, Employee>,
    
    /// CHECK: This is the employee's pubkey, we're not accessing their account
    pub employee: AccountInfo<'info>,
    
    #[account(mut)]
    pub owner: Signer<'info>, // company owner
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DepositPayroll<'info> {
    #[account(
        mut,
        seeds = [COMPANY_SEED, owner.key().as_ref()],
        bump,
        has_one = owner @ StreamPayError::UnauthorizedCompanyAccess
    )]
    pub company: Account<'info, Company>,
    
    #[account(mut)]
    pub owner: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClockIn<'info> {
    #[account(
        mut,
        seeds = [EMPLOYEE_SEED, employee_account.company.as_ref(), employee.key().as_ref()],
        bump,
        has_one = employee @ StreamPayError::UnauthorizedEmployeeAccess
    )]
    pub employee_account: Account<'info, Employee>,
    
    #[account(
        init,
        payer = employee,
        space = 8 + size_of::<WorkSession>(),
        seeds = [
            WORK_SESSION_SEED, 
            employee.key().as_ref(),
            &employee_account.total_sessions_count.to_le_bytes()
        ],
        bump
    )]
    pub work_session: Account<'info, WorkSession>,
    
    #[account(mut)]
    pub employee: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClockOut<'info> {
    #[account(
        mut,
        seeds = [EMPLOYEE_SEED, employee_account.company.as_ref(), employee.key().as_ref()],
        bump,
        has_one = employee @ StreamPayError::UnauthorizedEmployeeAccess
    )]
    pub employee_account: Account<'info, Employee>,
    
    #[account(
        mut,
        seeds = [
            WORK_SESSION_SEED,
            employee.key().as_ref(), 
            &employee_account.total_sessions_count.checked_sub(1).unwrap().to_le_bytes()
        ],
        bump
    )]
    pub work_session: Account<'info, WorkSession>,
    
    pub employee: Signer<'info>,
}

#[derive(Accounts)]
pub struct WithdrawEarnings<'info> {
    #[account(
        seeds = [COMPANY_SEED, company.owner.as_ref()],
        bump
    )]
    pub company: Account<'info, Company>,
    
    #[account(
        mut,
        seeds = [EMPLOYEE_SEED, company.key().as_ref(), employee.key().as_ref()],
        bump,
        has_one = employee @ StreamPayError::UnauthorizedEmployeeAccess
    )]
    pub employee_account: Account<'info, Employee>,
    
    #[account(mut)]
    pub employee: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct GetAvailableBalance<'info> {
    #[account(
        seeds = [EMPLOYEE_SEED, employee_account.company.as_ref(), employee.key().as_ref()],
        bump,
        has_one = employee @ StreamPayError::UnauthorizedEmployeeAccess
    )]
    pub employee_account: Account<'info, Employee>,
    
    pub employee: Signer<'info>,
}

// ==================== EVENTS ====================

#[event]
pub struct CompanyInitialized {
    pub company: Pubkey,
    pub owner: Pubkey,
    pub company_name: String,
    pub timestamp: i64,
}

#[event]
pub struct EmployeeAdded {
    pub company: Pubkey,
    pub employee: Pubkey,
    pub hourly_rate: u64,
    pub timestamp: i64,
}

#[event]
pub struct PayrollDeposited {
    pub company: Pubkey,
    pub owner: Pubkey,
    pub amount: u64,
    pub new_balance: u64,
    pub timestamp: i64,
}

#[event]
pub struct EmployeeClockedIn {
    pub employee: Pubkey,
    pub company: Pubkey,
    pub clock_in_time: i64,
    pub session_id: u64,
}

#[event]
pub struct EmployeeClockedOut {
    pub employee: Pubkey,
    pub company: Pubkey,
    pub clock_out_time: i64,
    pub hours_worked: u64,
    pub amount_earned: u64,
    pub session_id: u64,
}

#[event]
pub struct EarningsWithdrawn {
    pub employee: Pubkey,
    pub company: Pubkey,
    pub amount: u64,
    pub remaining_balance: u64,
    pub timestamp: i64,
}

// ==================== ERROR TYPES ====================

#[error_code]
pub enum StreamPayError {
    #[msg("Company name cannot be empty")]
    InvalidCompanyName,
    
    #[msg("Company name is too long (max 32 characters)")]
    CompanyNameTooLong,
    
    #[msg("Hourly rate must be greater than 0")]
    InvalidHourlyRate,
    
    #[msg("Deposit amount must be greater than 0")]
    InvalidDepositAmount,
    
    #[msg("Already clocked in! Please clock out first")]
    AlreadyClockedIn,
    
    #[msg("Not currently clocked in")]
    NotClockedIn,
    
    #[msg("Invalid clock out time - must be after clock in")]
    InvalidClockOutTime,
    
    #[msg("Withdrawal amount must be greater than 0")]
    InvalidWithdrawAmount,
    
    #[msg("Insufficient balance for withdrawal")]
    InsufficientBalance,
    
    #[msg("Unauthorized: Only company owner can perform this action")]
    UnauthorizedCompanyAccess,
    
    #[msg("Unauthorized: Only the employee can perform this action")]
    UnauthorizedEmployeeAccess,
    
    #[msg("Mathematical overflow occurred")]
    Overflow,
}
