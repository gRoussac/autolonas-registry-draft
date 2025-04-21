use anchor_lang::prelude::*;

#[event]
pub struct CreateServiceEvent {
    pub service_id: u128,
    pub config_hash: [u8; 32],
}

#[event]
pub struct RegisterAgentIdsEvent {
    pub service_id: u128,
    pub agent_ids: Vec<u32>,
    pub max_num_agent_instances: u32,
    pub security_deposit: u128,
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
pub struct ActivateRegistrationEvent {
    pub service_id: u64,
}
