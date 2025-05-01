#![allow(unexpected_cfgs)]
use anchor_lang::prelude::*;

#[repr(u8)]
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, Default, PartialEq)]
pub enum ServiceState {
    #[default]
    NonExistent,
    PreRegistration,
    ActiveRegistration,
    FinishedRegistration,
    Deployed,
    TerminatedBonded,
}
