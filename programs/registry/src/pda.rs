use anchor_lang::prelude::*;

pub fn registry_wallet_pda(registry: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"registry_wallet", &registry.to_bytes()], program_id)
}

pub fn agent_param_pda(service_id: u128, agent_id: u32, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"agent_param",
            &service_id.to_le_bytes(),
            &agent_id.to_le_bytes(),
        ],
        program_id,
    )
}

pub fn service_pda(config_hash: &[u8], program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(&[b"service", &config_hash[..7]], program_id)
}

pub fn service_agent_ids_index_pda(service_id: u128, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"service_agent_ids_index", &service_id.to_le_bytes()],
        program_id,
    )
}

pub fn service_agent_slot_counter_pda(
    service_id: u128,
    agent_id: u32,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"service_agent_slot",
            &service_id.to_le_bytes(),
            &agent_id.to_le_bytes(),
        ],
        program_id,
    )
}

pub fn agent_instances_index_pda(
    service_id: u128,
    agent_id: u32,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"agent_instances_index",
            &service_id.to_le_bytes(),
            &agent_id.to_le_bytes(),
        ],
        program_id,
    )
}

pub fn operator_as_agent_index_pda(operator: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[b"agent_instances_index", &operator.to_bytes()],
        program_id,
    )
}

pub fn service_agent_instance_pda(
    service_id: u128,
    agent_id: u32,
    agent_instance: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"service_agent_instance_account",
            &service_id.to_le_bytes(),
            &agent_id.to_le_bytes(),
            &agent_instance.to_bytes(),
        ],
        program_id,
    )
}

pub fn operator_agent_instance_pda(
    agent_instance: &Pubkey,
    operator: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"operator_agent_instance",
            &agent_instance.to_bytes(),
            &operator.to_bytes(),
        ],
        program_id,
    )
}

pub fn operator_agent_instance_index_pda(
    service_id: u128,
    operator: &Pubkey,
    program_id: &Pubkey,
) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"operator_agent_instance_index",
            &service_id.to_le_bytes(),
            &operator.to_bytes(),
        ],
        program_id,
    )
}

pub fn operator_bond_pda(service_id: u128, operator: &Pubkey, program_id: &Pubkey) -> (Pubkey, u8) {
    Pubkey::find_program_address(
        &[
            b"operator_bond",
            &service_id.to_le_bytes(),
            &operator.to_bytes(),
        ],
        program_id,
    )
}
