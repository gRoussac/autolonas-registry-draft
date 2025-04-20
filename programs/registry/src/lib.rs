use anchor_lang::{
    prelude::*,
    solana_program::{program::invoke_signed, system_instruction},
};

pub mod error;
pub mod events;
use error::ErrorCode;

const MAX_AGENT_IDS_PER_SERVICE: usize = 128;

declare_id!("9Q2mQxDLH91HLaQUYyxV5n9WhA1jzgVThJwfJTNqEUNP");

const STRING_PREFIX_SIZE: usize = 4;
const MAX_NAME_LENGTH: usize = 256;
const MAX_SYMBOL_LENGTH: usize = 64;
const MAX_URI_LENGTH: usize = 512;
const PUBKEY_SIZE: usize = 32;
const U64_SIZE: usize = 8;
const U128_SIZE: usize = 16;
const BOOL_SIZE: usize = 1;
const FIXED_SIZE: usize = 32;

const REGISTRY_ACCOUNT_SIZE: usize = STRING_PREFIX_SIZE
    + MAX_NAME_LENGTH
    + STRING_PREFIX_SIZE
    + MAX_SYMBOL_LENGTH
    + STRING_PREFIX_SIZE
    + MAX_URI_LENGTH
    + PUBKEY_SIZE
    + PUBKEY_SIZE
    + PUBKEY_SIZE
    + U64_SIZE
    + U128_SIZE
    + STRING_PREFIX_SIZE
    + FIXED_SIZE
    + BOOL_SIZE;

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct AgentParams {
    pub slots: u32,
    pub bond: u128,
}

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
    pub version: String,    // 4 bytes + max_len
    pub locked: bool,       // 1 byte
}

#[account]
pub struct ServiceAccount {
    pub service_id: u128,             // 16 bytes
    pub service_owner: Pubkey,        // 32 bytes
    pub security_deposit: u128,       // 16 bytes
    pub multisig: Pubkey,             // 32 bytes
    pub config_hash: [u8; 32],        // 32 bytes
    pub threshold: u32,               // 4 bytes
    pub max_num_agent_instances: u32, // 4 bytes
    pub num_agent_instances: u32,     // 4 bytes
    pub state: ServiceState,          // 1 byte
}

#[account]
pub struct AgentParamAccount {
    pub agent_id: u32,
    pub slots: u32,
    pub bond: u128,
}

impl AgentParamAccount {
    pub const LEN: usize = 8 + 16 + 4 + 4 + 16;
}

#[account]
pub struct ServiceAgentIdsIndex {
    pub agent_ids: Vec<AgentParamAccount>,
}

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

#[program]
pub mod registry {

    use crate::{
        error::ErrorCode,
        events::{CreateServiceEvent, DrainerUpdatedEvent, OwnerUpdatedEvent, UpdateServiceEvent},
    };

    use super::*;

    pub fn initialize(
        ctx: Context<Initialize>,
        name: String,
        symbol: String,
        base_uri: String,
        manager: Pubkey,
        drainer: Pubkey,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;

        registry.name = name;
        registry.symbol = symbol;
        registry.base_uri = base_uri;
        registry.owner = ctx.accounts.user.key();
        registry.manager = manager;
        registry.drainer = drainer;
        registry.total_supply = 0;
        registry.version = "1.0.0".into();

        Ok(())
    }

    pub fn create(
        ctx: Context<CreateService>,
        config_hash: [u8; 32],
        service_owner: Pubkey,
        threshold: Option<u32>,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;

        if registry.locked {
            return Err(ErrorCode::ReentrancyGuard.into());
        }

        registry.locked = true;

        // Check for the manager privilege for a service management
        if ctx.accounts.user.key() != registry.manager {
            return Err(Error::from(ProgramError::InvalidAccountOwner));
        }

        // Check for the non-empty service owner address
        if service_owner == Pubkey::default() {
            return Err(ProgramError::InvalidArgument.into());
        }

        // Check for zero config hash
        if config_hash == [0u8; 32] {
            return Err(ErrorCode::ZeroConfigHash.into());
        }

        let service_id = registry.total_supply + 1;

        let service = &mut ctx.accounts.service;
        service.service_id = service_id;
        service.service_owner = service_owner;
        service.security_deposit = 0;
        // service.multisig = multisig;
        service.config_hash = config_hash;
        service.max_num_agent_instances = 0;
        service.num_agent_instances = 0;
        service.state = ServiceState::PreRegistration;

        if threshold.is_some() {
            service.threshold = threshold.unwrap_or_default();
        }

        emit!(CreateServiceEvent {
            service_id,
            config_hash
        });

        registry.total_supply = service_id;
        registry.locked = false;

        Ok(())
    }

    pub fn update(
        ctx: Context<UpdateService>,
        config_hash: [u8; 32],
        service_owner: Pubkey,
        threshold: Option<u32>,
    ) -> Result<()> {
        let service = &mut ctx.accounts.service;
        let registry = &mut ctx.accounts.registry;

        // Only the manager can update the service
        if ctx.accounts.user.key() != registry.manager {
            return Err(Error::from(ProgramError::InvalidAccountOwner));
        }

        // Validate that the provided service owner is the actual owner of the service
        if service.service_owner != service_owner {
            return Err(Error::from(ProgramError::InvalidArgument));
        }

        // Check if the service state is PreRegistration, only then can the service be updated
        if service.state != ServiceState::PreRegistration {
            return Err(ErrorCode::WrongServiceState.into());
        }

        // Ensure the config hash is not empty
        if config_hash == [0u8; 32] {
            return Err(ErrorCode::ZeroConfigHash.into());
        }

        ServiceRegistry::validate_threshold(service, threshold)?;

        // Update the service configuration hash
        let last_config_hash = service.config_hash;
        if last_config_hash != config_hash {
            service.config_hash = config_hash;
        }

        emit!(UpdateServiceEvent {
            service_id: service.service_id,
            config_hash
        });

        Ok(())
    }

    pub fn register_agents<'info>(
        ctx: Context<'_, '_, 'info, 'info, RegisterAgents<'info>>,
        service_owner: Pubkey,
        agent_ids: Vec<u32>,
        agent_params: Vec<AgentParams>,
        threshold: Option<u32>,
    ) -> Result<()> {
        ServiceRegistry::initial_checks(&agent_ids, &agent_params)?;

        let registry = &mut ctx.accounts.registry;
        let service = &mut ctx.accounts.service;
        let service_agent_ids_index = &mut ctx.accounts.service_agent_ids_index;

        // Check for the manager privilege for a service management
        if ctx.accounts.user.key() != registry.manager {
            return Err(Error::from(ProgramError::UninitializedAccount));
        }

        if service_owner != service.service_owner {
            return Err(Error::from(ProgramError::InvalidAccountOwner));
        }

        let program_id = ctx.program_id;
        let user_account_info = ctx.accounts.user.to_account_info();
        let system_program_account_info = ctx.accounts.system_program.to_account_info().clone();
        let mut remaining_accounts = ctx.remaining_accounts.iter();

        // Temp new state to rebuild service metadata
        let mut new_max_num_agent_instances: u32 = 0;
        let mut new_security_deposit = 0;

        for i in 0..agent_ids.len() {
            let agent_id = agent_ids[i];
            let params = &agent_params[i];

            let agent_param_account_info = next_account_info(&mut remaining_accounts)?;

            let (agent_param_pda, agent_param_bump) = Pubkey::find_program_address(
                &[
                    b"agent_param",
                    &service.service_id.to_le_bytes(),
                    &agent_id.to_le_bytes(),
                ],
                program_id,
            );

            require!(
                agent_param_pda == *agent_param_account_info.key,
                ErrorCode::InvalidPda
            );

            // === CREATE OR UPDATE AGENT_PARAM ===
            if agent_param_account_info.data_is_empty() {
                let agent_param_seeds: &[&[u8]] = &[
                    b"agent_param",
                    &service.service_id.to_le_bytes(),
                    &agent_id.to_le_bytes(),
                    &[agent_param_bump],
                ];

                invoke_signed(
                    &system_instruction::create_account(
                        &ctx.accounts.user.key(),
                        &agent_param_pda,
                        Rent::get()?.minimum_balance(AgentParamAccount::LEN),
                        AgentParamAccount::LEN as u64,
                        program_id,
                    ),
                    &[
                        user_account_info.clone(),
                        agent_param_account_info.clone(),
                        system_program_account_info.clone(),
                    ],
                    &[agent_param_seeds],
                )?;

                require_keys_eq!(
                    *agent_param_account_info.owner,
                    *program_id,
                    ErrorCode::InvalidAccountOwner
                );
            }

            let mut agent_param_data: Account<AgentParamAccount> =
                Account::try_from_unchecked(agent_param_account_info)?;

            if params.slots == 0 && !agent_param_account_info.data_is_empty() {
                // === DELETION MODE ===

                **user_account_info.try_borrow_mut_lamports()? +=
                    agent_param_account_info.lamports();
                **agent_param_account_info.try_borrow_mut_lamports()? = 0;
                agent_param_account_info.data.borrow_mut().fill(0);

                ServiceRegistry::delete_agent_param_index(
                    &mut service_agent_ids_index.agent_ids,
                    agent_id,
                );
                continue;
            }

            agent_param_data.agent_id = agent_id;
            agent_param_data.slots = params.slots;
            agent_param_data.bond = params.bond;

            ServiceRegistry::upsert_agent_param_index(
                &mut service_agent_ids_index.agent_ids,
                (*agent_param_data).clone(),
            );
        }

        // === Recompute `new_max_num_agent_instances` and `new_security_deposit` ===
        // After adding/updating the agent params, loop over all agent_ids in the service
        for params in &service_agent_ids_index.agent_ids {
            // Recompute max number of agent instances (total slots)
            new_max_num_agent_instances = new_max_num_agent_instances.saturating_add(params.slots);
            // Recompute security deposit (max bond)
            new_security_deposit = new_security_deposit.max(params.bond);
        }

        // === FINAL SERVICE STATE UPDATE ===
        service.max_num_agent_instances = new_max_num_agent_instances;
        service.security_deposit = new_security_deposit;

        ServiceRegistry::validate_threshold(service, threshold)?;

        Ok(())
    }

    pub fn delete_agent<'info>(
        ctx: Context<'_, '_, 'info, 'info, RegisterAgents<'info>>,
        service_owner: Pubkey,
        agent_id: u32,
        threshold: Option<u32>,
    ) -> Result<()> {
        let agent_ids = vec![agent_id];
        let agent_params = vec![AgentParams { slots: 0, bond: 0 }];

        register_agents(ctx, service_owner, agent_ids, agent_params, threshold)
    }

    pub fn add_agent<'info>(
        ctx: Context<'_, '_, 'info, 'info, RegisterAgents<'info>>,
        service_owner: Pubkey,
        agent_id: u32,
        slots: u32,
        bond: u128,
        threshold: Option<u32>,
    ) -> Result<()> {
        let agent_ids = vec![agent_id];
        let agent_params = vec![AgentParams { slots, bond }];

        register_agents(ctx, service_owner, agent_ids, agent_params, threshold)
    }

    pub fn change_drainer(ctx: Context<ChangeDrainer>, new_drainer: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;

        // Only owner can call
        if ctx.accounts.user.key() != registry.owner {
            return Err(Error::from(ProgramError::IllegalOwner));
        }

        // Cannot set zero address
        if new_drainer == Pubkey::default() {
            return Err(ProgramError::InvalidArgument.into());
        }

        registry.drainer = new_drainer;

        emit!(DrainerUpdatedEvent { new_drainer });

        Ok(())
    }

    pub fn change_owner(ctx: Context<ChangeOwner>, new_owner: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;

        // Only current owner can call
        if ctx.accounts.user.key() != registry.owner {
            return Err(Error::from(ProgramError::IllegalOwner));
        }

        // Cannot set zero address
        if new_owner == Pubkey::default() {
            return Err(ProgramError::InvalidArgument.into());
        }

        // Update the owner
        registry.owner = new_owner;

        emit!(OwnerUpdatedEvent { new_owner });

        Ok(())
    }
}

impl ServiceRegistry {
    fn initial_checks(agent_ids: &[u32], agent_params: &[AgentParams]) -> Result<()> {
        // Check arrays are non-empty and of equal length
        if agent_ids.is_empty() || agent_ids.len() != agent_params.len() {
            return Err(ErrorCode::WrongArrayLength.into());
        }

        // Check agent IDs are strictly increasing (sorted without duplicates)
        let mut last_id: u32 = 0;
        for (i, &id) in agent_ids.iter().enumerate() {
            if i > 0 && id <= last_id {
                return Err(ErrorCode::WrongAgentId.into());
            }
            last_id = id;
        }

        // Check for zero values in slots or bond
        for (_, params) in agent_ids.iter().zip(agent_params.iter()) {
            if (params.slots == 0 && params.bond != 0) || (params.slots != 0 && params.bond == 0) {
                return Err(ErrorCode::ZeroValue.into());
            }
        }

        Ok(())
    }

    fn upsert_agent_param_index(vec: &mut Vec<AgentParamAccount>, param: AgentParamAccount) {
        if let Some(existing) = vec.iter_mut().find(|x| x.agent_id == param.agent_id) {
            *existing = param;
        } else {
            vec.push(param);
        }
    }

    fn delete_agent_param_index(vec: &mut Vec<AgentParamAccount>, agent_id: u32) {
        if let Some(index) = vec.iter().position(|x| x.agent_id == agent_id) {
            vec.remove(index);
        }
    }

    pub fn validate_threshold(service: &mut ServiceAccount, threshold: Option<u32>) -> Result<()> {
        // Set the threshold if provided
        if threshold.is_some() {
            service.threshold = threshold.unwrap_or_default();
        }

        // Calculate the check_threshold value based on max_num_agent_instances
        let check_threshold = (service.max_num_agent_instances * 2 + 1).div_ceil(3);

        // Validate the threshold value as per the condition provided
        if service.threshold < check_threshold {
            return Err(ErrorCode::WrongThreshold.into());
        }

        if service.threshold > service.max_num_agent_instances {
            return Err(ErrorCode::WrongThreshold2.into());
        }

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = REGISTRY_ACCOUNT_SIZE)]
    pub registry: Account<'info, ServiceRegistry>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(config_hash: [u8; 32])]
pub struct CreateService<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,

    #[account(
        init,
        payer = user,
        space = 8 + std::mem::size_of::<ServiceAccount>(),
        seeds = [b"service", &config_hash[..7]],
        bump,
    )]
    pub service: Account<'info, ServiceAccount>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UpdateService<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,

    #[account(mut)]
    pub service: Account<'info, ServiceAccount>,

    #[account(mut, address = registry.manager)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAgents<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,

    #[account(mut)]
    pub service: Account<'info, ServiceAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + (MAX_AGENT_IDS_PER_SERVICE * AgentParamAccount::LEN) + 16, // 8 bytes for Vec metadata + data for MAX_AGENT_IDS_PER_SERVICE u32 agent IDs + 16 bytes Vec overhead
        seeds = [b"service_agent_ids_index", &service.service_id.to_le_bytes()[..]],
        bump,
    )]
    pub service_agent_ids_index: Account<'info, ServiceAgentIdsIndex>,

    #[account(mut, address = registry.manager)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ChangeDrainer<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct ChangeOwner<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,
    pub user: Signer<'info>,
}
