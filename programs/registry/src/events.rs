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
    pub security_deposit: u64,
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
    pub service_id: u128,
}

#[event]
pub struct RegisterInstance {
    pub operator: Pubkey,
    pub service_id: u128,
    pub agent_instance: Pubkey,
    pub agent_id: u32,
}

#[event]
pub struct Deposit {
    pub operator: Pubkey,
    pub amount: u64,
}

#[event]
pub struct Refunded {
    pub service_owner: Pubkey,
    pub amount: u64,
}

#[event]
pub struct ServiceTerminated {
    pub service_id: u128,
}

#[event]
pub struct OperatorUnbonded {
    pub operator: Pubkey,
    pub service_id: u128,
    pub refund: u64,
}

#[event]
pub struct DrainEvent {
    pub drainer: Pubkey,
    pub amount: u64,
}

#[event]
pub struct OperatorSlashed {
    pub service_id: u128,
    pub operator: Pubkey,
    pub amount: u64,
}
