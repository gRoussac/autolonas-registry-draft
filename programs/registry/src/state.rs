#![allow(unexpected_cfgs)]
use anchor_lang::{prelude::*, Discriminator};

use crate::{constants::*, service_state::ServiceState};

#[account]
pub struct ServiceRegistry {
    pub name: String,       // 4 bytes (length prefix) + max_len
    pub symbol: String,     // 4 bytes + max_len
    pub base_uri: String,   // 4 bytes + max_len
    pub owner: Pubkey,      // 32 bytes
    pub manager: Pubkey,    // 32 bytes
    pub drainer: Pubkey,    // 32 bytes
    pub slashed_funds: u64, // 8 bytes
    pub total_supply: u128, // 16 bytes
    pub version: String,    // 4 bytes + FIXED_SIZE
    pub locked: bool,       // 1 byte
    pub wallet_key: Pubkey, // 32 bytes
    pub wallet_bump: u8,    // 1 byte
}

/// PDA seeds: ["service", config_hash[..7]]
#[account]
pub struct ServiceAccount {
    pub service_id: u128,             // 16 bytes
    pub service_owner: Pubkey,        // 32 bytes
    pub security_deposit: u64,        // 8 bytes
    pub multisig: Pubkey,             // 32 bytes
    pub config_hash: [u8; 32],        // 32 bytes
    pub threshold: u32,               // 4 bytes
    pub max_num_agent_instances: u32, // 4 bytes
    pub num_agent_instances: u32,     // 4 bytes
    pub state: ServiceState,          // 1 byte
}

/// PDA seeds: ["agent_param", service_id, agent_id]
#[account]
pub struct AgentParamAccount {
    pub agent_id: u32,
    pub slots: u32,
    pub bond: u64,
}

impl AgentParamAccount {
    pub const LEN: usize = 8 + 4 + 4 + U64_SIZE;
}

/// PDA seeds: ["service_agent_ids_index", service_id]
#[account]
pub struct ServiceAgentIdsIndex {
    pub agent_ids: Vec<AgentParamAccount>,
}

/// PDA seeds: ["service_agent_instance_account", service_id, agent_id, agent_instance]
#[account]
pub struct ServiceAgentInstanceAccount {
    pub service_id: u128,
    pub agent_id: u32,
    pub agent_instance: Pubkey,
}

impl ServiceAgentInstanceAccount {
    pub const LEN: usize = 8 + U128_SIZE + 4 + PUBKEY_SIZE;
}

/// PDA seeds: ["service_agent_slot", service_id, agent_id]
#[account]
pub struct ServiceAgentSlotCounterAccount {
    pub count: u8,
}

/// PDA seeds: ["agent_instances_index", service_id, agent_id]
#[account]
pub struct ServiceAgentInstancesIndex {
    pub service_agent_instances: Vec<Pubkey>,
}

impl ServiceAgentInstancesIndex {
    pub const LEN: usize = 8 + U128_SIZE + 4 + 8 + (MAX_AGENT_INSTANCES_PER_SERVICE * PUBKEY_SIZE);
}

/// PDA seeds: ["operator_agent_instance", agent_instance, operator]
#[account]
pub struct OperatorAgentInstanceAccount {
    pub operator: Pubkey,
    pub service_agent_instance: Pubkey,
}

impl OperatorAgentInstanceAccount {
    pub const LEN: usize = 8 + PUBKEY_SIZE + PUBKEY_SIZE;
}

/// PDA seeds: ["operator_agent_instance_index", service_id, operator]
#[account]
pub struct OperatorAgentInstanceIndex {
    pub operator_agent_instances: Vec<Pubkey>,
}

/// PDA seeds: ["operator_bond", service_id, operator]
#[account]
pub struct OperatorBondAccount {
    pub service_id: u128,
    pub operator: Pubkey,
    pub bond: u64,
}

impl OperatorBondAccount {
    pub const LEN: usize = 8 + U128_SIZE + PUBKEY_SIZE + U64_SIZE;
}
