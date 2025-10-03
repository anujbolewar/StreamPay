use anchor_lang::prelude::*;

declare_id!("jQrBRLbEtgwUdvcaetiWJJR3HztTEkER3W2tC8A4Vt3");

#[program]
pub mod streampay {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!("Greetings from: {:?}", ctx.program_id);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
