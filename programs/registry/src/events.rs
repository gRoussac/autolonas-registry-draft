use anchor_lang::prelude::*;

#[event]
pub struct CreateServiceEvent {
    pub service_id: u128,
    pub config_hash: [u8; 32],
}

#[event]
pub struct UpdateServiceEvent {
    pub service_id: u128,
    pub config_hash: [u8; 32],
}

#[event]
pub struct DrainerUpdatedEvent {
    pub new_drainer: Pubkey,
}

#[event]
pub struct OwnerUpdatedEvent {
    pub new_owner: Pubkey,
}
