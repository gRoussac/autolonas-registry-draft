#![allow(unexpected_cfgs)]
use anchor_lang::{
    prelude::*,
    solana_program::{
        program::invoke_signed,
        system_instruction::{self, transfer},
        system_program,
    },
    AccountDeserialize, Discriminator,
};

pub mod error;
pub mod events;
use error::ErrorCode;
use events::{Deposit, RegisterInstance};

const MAX_AGENT_IDS_PER_SERVICE: usize = 128;
const MAX_AGENT_INSTANCES_PER_SERVICE: usize = 192;

declare_id!("9Q2mQxDLH91HLaQUYyxV5n9WhA1jzgVThJwfJTNqEUNP");

const STRING_PREFIX_SIZE: usize = 4;
const MAX_NAME_LENGTH: usize = 256;
const MAX_SYMBOL_LENGTH: usize = 64;
const MAX_URI_LENGTH: usize = 512;
const PUBKEY_SIZE: usize = 32;
const U64_SIZE: usize = 8;
const U128_SIZE: usize = 16;
const BOOL_SIZE: usize = 1;
const U8_SIZE: usize = 1;
const FIXED_SIZE: usize = 32;

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

const REGISTRY_ACCOUNT_SIZE: usize = STRING_PREFIX_SIZE // name prefix
    + MAX_NAME_LENGTH   // name
    + STRING_PREFIX_SIZE// symbol prefix
    + MAX_SYMBOL_LENGTH // symbol
    + STRING_PREFIX_SIZE // base_uri prefix
    + MAX_URI_LENGTH // base_uri
    + PUBKEY_SIZE // owner
    + PUBKEY_SIZE // manager
    + PUBKEY_SIZE // drainer
    + U64_SIZE // slashed_funds
    + U128_SIZE // total_supply
    + STRING_PREFIX_SIZE // version prefix
    + FIXED_SIZE // version fixed size
    + BOOL_SIZE // locked
    + PUBKEY_SIZE // wallet_key
    + U8_SIZE; // wallet_bump

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

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct AgentParams {
    pub slots: u32,
    pub bond: u64,
}

#[account]
pub struct AgentParamAccount {
    pub agent_id: u32,
    pub slots: u32,
    pub bond: u64,
}

impl AgentParamAccount {
    pub const LEN: usize = 8 + 4 + 4 + U64_SIZE;
}

#[account]
pub struct ServiceAgentIdsIndex {
    pub agent_ids: Vec<AgentParamAccount>,
}

#[account]
pub struct ServiceAgentInstanceAccount {
    pub service_id: u128,
    pub agent_id: u32,
    pub agent_instance: Pubkey,
}

impl ServiceAgentInstanceAccount {
    pub const LEN: usize = 8 + U128_SIZE + 4 + PUBKEY_SIZE;
}

#[account]
pub struct ServiceAgentSlotCounterAccount {
    pub count: u8,
}

#[account]
pub struct AgentInstancesAccount {
    pub service_id: u128,
    pub agent_id: u32,
    pub agent_instances: Vec<Pubkey>,
}

impl AgentInstancesAccount {
    pub const LEN: usize = 8 + U128_SIZE + 4 + 8 + (MAX_AGENT_INSTANCES_PER_SERVICE * PUBKEY_SIZE);
}

#[account]
pub struct AgentInstanceOperatorAccount {
    pub service_agent_instance_pda: Pubkey,
    pub operator: Pubkey,
}

impl AgentInstanceOperatorAccount {
    pub const LEN: usize = 8 + PUBKEY_SIZE + PUBKEY_SIZE;
}

#[account]
pub struct AgentInstanceOperatorIndex {
    pub agent_instance_operator_pda: Vec<Pubkey>,
}

#[account]
pub struct OperatorBondAccount {
    pub service_id: u128,
    pub operator: Pubkey,
    pub bond: u64,
}

impl OperatorBondAccount {
    pub const LEN: usize = 8 + U128_SIZE + PUBKEY_SIZE + U64_SIZE;
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

    use anchor_lang::solana_program::system_instruction::transfer;

    use crate::{
        error::ErrorCode,
        events::{
            ActivateRegistrationEvent, CreateServiceEvent, DrainerUpdatedEvent, OperatorUnbonded,
            Refunded, RegisterAgentIdsEvent, ServiceTerminated, UpdateServiceEvent,
        },
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
        let registry_wallet = &mut ctx.accounts.registry_wallet;

        registry.name = name;
        registry.symbol = symbol;
        registry.base_uri = base_uri;
        registry.owner = ctx.accounts.user.key();
        registry.manager = manager;
        registry.drainer = drainer;
        registry.total_supply = 0;
        registry.version = "1.0.0".into();
        registry.wallet_key = registry_wallet.key();

        let (_, bump_registry_wallet) = Pubkey::find_program_address(
            &[b"registry_wallet", &registry.key().to_bytes()],
            ctx.program_id,
        );

        registry.wallet_bump = bump_registry_wallet;

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
            return Err(ProgramError::InvalidAccountOwner.into());
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
            return Err(ProgramError::InvalidAccountOwner.into());
        }

        // Validate that the provided service owner is the actual owner of the service
        if service.service_owner != service_owner {
            return Err(ProgramError::InvalidArgument.into());
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

    pub fn register_agent_ids_to_service<'info>(
        ctx: Context<'_, '_, 'info, 'info, RegisterAgentIdsToService<'info>>,
        service_owner: Pubkey,
        agent_ids: Vec<u32>,
        agent_params: Vec<AgentParams>,
        threshold: Option<u32>,
    ) -> Result<()> {
        ServiceRegistry::initial_checks(&agent_ids, &agent_params)?;

        let registry = &mut ctx.accounts.registry;
        let service = &mut ctx.accounts.service;

        // Check for the manager privilege for a service management
        if ctx.accounts.user.key() != registry.manager {
            return Err(ProgramError::UninitializedAccount.into());
        }

        if service_owner != service.service_owner {
            return Err(ProgramError::InvalidAccountOwner.into());
        }

        let program_id = ctx.program_id;
        let user_account_info = ctx.accounts.user.to_account_info();
        let system_program_account_info = ctx.accounts.system_program.to_account_info();
        let service_agent_ids_index = &mut ctx.accounts.service_agent_ids_index;
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
                agent_param_pda == agent_param_account_info.key(),
                ErrorCode::InvalidPda
            );

            //  CREATE OR UPDATE AGENT_PARAM
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
                //  DELETION MODE

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

            require!(
                service_agent_ids_index.agent_ids.len() < MAX_AGENT_IDS_PER_SERVICE,
                ErrorCode::MaxAgentIdPerServiceReached
            );

            ServiceRegistry::upsert_agent_param_index(
                &mut service_agent_ids_index.agent_ids,
                &agent_param_data,
            );

            let mut data = agent_param_account_info.try_borrow_mut_data()?;

            // ! Write discriminator, this is important to retrieve the account later
            let discriminator =
                &anchor_lang::solana_program::hash::hash("account:AgentParamAccount".as_bytes())
                    .to_bytes()[..8];
            data[..8].copy_from_slice(discriminator);

            agent_param_data.serialize(&mut &mut data[8..])?;
        }

        //  Recompute `new_max_num_agent_instances` and `new_security_deposit`
        // After adding/updating the agent params, loop over all agent_ids in the service
        for params in &service_agent_ids_index.agent_ids {
            // Recompute max number of agent instances (total slots)
            new_max_num_agent_instances = new_max_num_agent_instances.saturating_add(params.slots);
            // Recompute security deposit (max bond)
            new_security_deposit = new_security_deposit.max(params.bond);
        }

        //  FINAL SERVICE STATE UPDATE
        service.max_num_agent_instances = new_max_num_agent_instances;
        service.security_deposit = new_security_deposit;

        ServiceRegistry::validate_threshold(service, threshold)?;

        // Emit the event with updated service data
        emit!(RegisterAgentIdsEvent {
            service_id: service.service_id,
            agent_ids,
            max_num_agent_instances: new_max_num_agent_instances,
            security_deposit: new_security_deposit,
        });

        Ok(())
    }

    pub fn delete_agent_id_to_service<'info>(
        ctx: Context<'_, '_, 'info, 'info, RegisterAgentIdsToService<'info>>,
        service_owner: Pubkey,
        agent_id: u32,
        threshold: Option<u32>,
    ) -> Result<()> {
        let agent_ids = vec![agent_id];
        let agent_params = vec![AgentParams { slots: 0, bond: 0 }];

        register_agent_ids_to_service(ctx, service_owner, agent_ids, agent_params, threshold)
    }

    pub fn add_agent_id_to_service<'info>(
        ctx: Context<'_, '_, 'info, 'info, RegisterAgentIdsToService<'info>>,
        service_owner: Pubkey,
        agent_id: u32,
        slots: u32,
        bond: u64,
        threshold: Option<u32>,
    ) -> Result<()> {
        let agent_ids = vec![agent_id];
        let agent_params = vec![AgentParams { slots, bond }];

        register_agent_ids_to_service(ctx, service_owner, agent_ids, agent_params, threshold)
    }

    pub fn change_drainer(ctx: Context<ChangeDrainer>, new_drainer: Pubkey) -> Result<()> {
        let registry = &mut ctx.accounts.registry;

        // Only owner can call
        if ctx.accounts.user.key() != registry.owner {
            return Err(ProgramError::IllegalOwner.into());
        }

        // Cannot set zero address
        if new_drainer == Pubkey::default() {
            return Err(ProgramError::InvalidArgument.into());
        }

        registry.drainer = new_drainer;

        emit!(DrainerUpdatedEvent { new_drainer });

        Ok(())
    }

    pub fn check_service(ctx: Context<CheckService>, service_id: u128) -> Result<()> {
        let service_account = &ctx.accounts.service;
        // Find the Service Account PDA
        let (service_pda, _bump) = Pubkey::find_program_address(
            &[b"service", &service_account.config_hash[..7]],
            ctx.program_id,
        );

        // Use the service PDA to load the service account
        // Ensure the service account is the expected one
        require!(service_account.key() == service_pda, ErrorCode::InvalidPda);
        require_eq!(service_account.service_id, service_id);

        let service_agent_ids_index = &mut ctx.accounts.service_agent_ids_index;

        let (expected_pda, _bump) = Pubkey::find_program_address(
            &[b"service_agent_ids_index", &service_id.to_le_bytes()],
            ctx.program_id,
        );

        require!(
            service_agent_ids_index.key() == expected_pda,
            ErrorCode::InvalidPda
        );

        require!(
            !service_agent_ids_index.agent_ids.is_empty(),
            ErrorCode::InvalidServiceAgentPda
        );

        Ok(())
    }

    pub fn activate_registration(
        ctx: Context<ActivateRegistration>,
        service_owner: Pubkey,
        service_id: u128,
    ) -> Result<()> {
        let registry = &ctx.accounts.registry;
        let service = &mut ctx.accounts.service;

        // Check for the manager privilege for a service management
        if ctx.accounts.user.key() != registry.manager {
            return Err(ProgramError::InvalidAccountOwner.into());
        }

        // Check for the non-empty service owner address
        if service_owner == Pubkey::default() {
            return Err(ProgramError::InvalidArgument.into());
        }

        require!(
            service.state == ServiceState::PreRegistration,
            ErrorCode::ServiceMustBeInactive
        );

        // Check that the deposit is the expected amount
        let user_pre_balance = ctx.accounts.user.lamports();
        require!(
            user_pre_balance >= service.security_deposit,
            ErrorCode::IncorrectRegistrationDepositValue
        );

        // Transfer the bond from user account to the program's wallet
        let (registry_wallet_pda, registry_wallet_bump) = Pubkey::find_program_address(
            &[b"registry_wallet", &registry.key().to_bytes()],
            ctx.program_id,
        );

        require_eq!(
            registry_wallet_pda,
            ctx.accounts.registry_wallet.key(),
            ErrorCode::WrongRegistryWallet
        );

        require_eq!(
            registry_wallet_pda,
            registry.wallet_key,
            ErrorCode::WrongRegistryWallet
        );

        require_eq!(
            registry_wallet_bump,
            registry.wallet_bump,
            ErrorCode::WrongRegistryWallet
        );

        let transfer_amount = service.security_deposit;

        let transfer_tx = transfer(
            &ctx.accounts.user.key(),
            &registry.wallet_key,
            transfer_amount,
        );

        // Execute the transfer
        invoke_signed(
            &transfer_tx,
            &[
                ctx.accounts.user.to_account_info(),
                ctx.accounts.registry_wallet.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
            &[&[
                b"registry_wallet",
                registry.key().as_ref(),
                &[registry_wallet_bump],
            ]],
        )?;

        // Verify exact amount was transferred
        let user_post_balance = ctx.accounts.user.lamports();

        let balance_diff = user_pre_balance
            .checked_sub(user_post_balance)
            .ok_or(ErrorCode::Overflow)?;

        require!(
            balance_diff == transfer_amount,
            ErrorCode::IncorrectRegistrationDepositValue
        );

        service.state = ServiceState::ActiveRegistration;

        emit!(ActivateRegistrationEvent { service_id });

        Ok(())
    }

    pub fn register_agents<'info>(
        ctx: Context<'_, '_, 'info, 'info, RegisterAgentInstances<'info>>,
        operator: Pubkey,
        agent_instances: Vec<Pubkey>,
        agent_ids: Vec<u32>,
    ) -> Result<()> {
        let registry = &ctx.accounts.registry;

        // Permissions & State Checks
        ServiceRegistry::check_access_and_state(
            &ctx,
            registry,
            &ctx.accounts.service.state,
            &agent_instances,
            &agent_ids,
        )?;

        let service = &mut ctx.accounts.service;
        let mut remaining_accounts = ctx.remaining_accounts.iter();

        // Extract & Validate Agent Params
        let (agent_params, total_bond) =
            ServiceRegistry::load_and_validate_agent_params(&mut remaining_accounts, &agent_ids)?;

        // Transfer Bond
        ServiceRegistry::transfer_bond(
            ctx.program_id,
            &ctx.accounts.user,
            &ctx.accounts.system_program,
            registry,
            &ctx.accounts.registry_wallet,
            total_bond,
        )?;

        // Validate Operator
        ServiceRegistry::validate_operator(*ctx.program_id, operator, &mut remaining_accounts)?;

        let program_id = ctx.program_id;
        let user_account_info = ctx.accounts.user.to_account_info();
        let system_program_account_info = ctx.accounts.system_program.to_account_info();
        let agent_instance_operator_index_account = &mut ctx.accounts.agent_instance_operator_index;

        for (i, agent_id) in agent_ids.iter().enumerate() {
            let agent_instance = agent_instances[i];
            let agent_param = &agent_params[i];

            ServiceRegistry::register_single_instance(
                program_id,
                service,
                *agent_id,
                agent_instance,
                agent_param,
                operator,
                &user_account_info,
                &system_program_account_info,
                agent_instance_operator_index_account,
                &mut remaining_accounts,
            )?;
        }

        // Finalize service state if full
        if service.num_agent_instances == service.max_num_agent_instances {
            service.state = ServiceState::FinishedRegistration;
        }

        // Extract the operator_bond account from remaining_accounts
        let operator_bond_account_info = next_account_info(&mut remaining_accounts)?;

        // Update operator bond account
        ServiceRegistry::update_operator_bond(
            program_id,
            operator,
            service.service_id,
            total_bond,
            &ctx.accounts.user,
            operator_bond_account_info,
            &ctx.accounts.system_program,
        )?;

        Ok(())
    }

    pub fn dummy_include_agent_param_account(
        _ctx: Context<DummyContextForAgentParam>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn dummy_include_agent_instances(_ctx: Context<DummyReadAgentInstances>) -> Result<()> {
        Ok(())
    }

    pub fn dummy_include_agent_instance_operator_account(
        _ctx: Context<DummyAgentInstanceOperatorAccount>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn dummy_include_service_agent_instance_account(
        _ctx: Context<DummyServiceAgentInstanceAccount>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn dummy_include_service_agent_slot_counter_account(
        _ctx: Context<DummyServiceAgentSlotCounterAccount>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn dummy_include_operator_bond_account(
        _ctx: Context<DummyOperatorBondAccount>,
    ) -> Result<()> {
        Ok(())
    }

    pub fn terminate<'info>(
        ctx: Context<'_, '_, 'info, 'info, TerminateService<'info>>,
        service_id: u128,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let service = &mut ctx.accounts.service;
        let service_owner = &ctx.accounts.service_owner;
        let service_agent_ids_index = &mut ctx.accounts.service_agent_ids_index;

        // Reentrancy guard
        if registry.locked {
            return Err(ErrorCode::ReentrancyGuard.into());
        }
        registry.locked = true;

        // Check for the manager privilege for service management
        if ctx.accounts.user.key() != registry.manager {
            return Err(ProgramError::InvalidAccountOwner.into());
        }

        // Validate that the provided service owner is the actual owner of the service
        if service.service_owner != service_owner.key() {
            return Err(ProgramError::InvalidArgument.into());
        }

        require!(service_id == service.service_id, ErrorCode::InvalidPda);

        // Check if already terminated
        require!(
            service.state != ServiceState::PreRegistration
                && service.state != ServiceState::TerminatedBonded,
            ErrorCode::WrongServiceState
        );

        // Update service state
        if service.num_agent_instances > 0 {
            service.state = ServiceState::TerminatedBonded;
        } else {
            service.state = ServiceState::PreRegistration;
        }

        let mut remaining_accounts_iter = ctx.remaining_accounts.iter();

        // Cleanup all agent instance PDAs
        for param in &service_agent_ids_index.agent_ids {
            // 1. Close the slot_counter PDA
            let (slot_counter_pda, _) = Pubkey::find_program_address(
                &[
                    b"service_agent_slot",
                    &service_id.to_le_bytes(),
                    &param.agent_id.to_le_bytes(),
                ],
                ctx.program_id,
            );

            let slot_counter_info = next_account_info(&mut remaining_accounts_iter)?;
            require!(
                slot_counter_info.key() == slot_counter_pda,
                ErrorCode::InvalidPda
            );
            ServiceRegistry::close_account(slot_counter_info, &ctx.accounts.user)?;

            // 2. Close the agent_instances PDA
            let (agent_instances_pda, _) = Pubkey::find_program_address(
                &[
                    b"agent_instances",
                    &service_id.to_le_bytes(),
                    &param.agent_id.to_le_bytes(),
                ],
                ctx.program_id,
            );

            let agent_instances_info = next_account_info(&mut remaining_accounts_iter)?;
            require!(
                agent_instances_info.key() == agent_instances_pda,
                ErrorCode::InvalidPda
            );

            // 3. Now close all service_agent_instance PDAs for each agent_instance
            let agent_instances_account: Account<AgentInstancesAccount> =
                Account::try_from(agent_instances_info)?;

            for agent_instance in agent_instances_account.agent_instances.iter() {
                let (service_agent_instance_pda, _) = Pubkey::find_program_address(
                    &[
                        b"service_agent_instance",
                        &service_id.to_le_bytes(),
                        &param.agent_id.to_le_bytes(),
                        &agent_instance.to_bytes(),
                    ],
                    ctx.program_id,
                );

                let service_agent_instance_info = next_account_info(&mut remaining_accounts_iter)?;
                require!(
                    service_agent_instance_info.key() == service_agent_instance_pda,
                    ErrorCode::InvalidPda
                );
                ServiceRegistry::close_account(service_agent_instance_info, &ctx.accounts.user)?;
            }

            ServiceRegistry::close_account(agent_instances_info, &ctx.accounts.user)?;
        }

        // Refund security deposit
        let refund = service.security_deposit;
        msg!(&refund.to_string());
        if refund > 0 {
            service.security_deposit = 0;

            let wallet_balance = ctx.accounts.registry_wallet.lamports();
            require!(wallet_balance >= refund, ErrorCode::InsufficientFunds);

            **ctx.accounts.registry_wallet.try_borrow_mut_lamports()? -= refund;
            **ctx.accounts.service_owner.try_borrow_mut_lamports()? += refund;

            emit!(Refunded {
                service_owner: ctx.accounts.service_owner.key(),
                amount: refund,
            });
        }

        service_agent_ids_index.agent_ids.clear();
        if service_agent_ids_index.agent_ids.is_empty() {
            ServiceRegistry::close_account(
                &service_agent_ids_index.to_account_info(),
                &ctx.accounts.user,
            )?;
        }

        emit!(ServiceTerminated { service_id });
        registry.locked = false;

        Ok(())
    }

    pub fn unbond<'info>(
        ctx: Context<'_, '_, 'info, 'info, UnbondOperator<'info>>,
        service_id: u128,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let service = &mut ctx.accounts.service;
        let operator = &mut ctx.accounts.operator;
        let operator_bond = &mut ctx.accounts.operator_bond;

        if registry.locked {
            return Err(ErrorCode::ReentrancyGuard.into());
        }

        registry.locked = true;

        require!(service_id == service.service_id, ErrorCode::InvalidPda);

        // Check for the manager privilege for a service management
        if ctx.accounts.user.key() != registry.manager {
            return Err(ProgramError::InvalidAccountOwner.into());
        }

        // Check for the non-empty service owner address
        if operator.key() == Pubkey::default() {
            return Err(ProgramError::InvalidArgument.into());
        }

        // Validate service state
        require!(
            service.state == ServiceState::TerminatedBonded,
            ErrorCode::WrongServiceState
        );

        // Load agent instances for the operator
        let agent_instance_operator_index = &mut ctx.accounts.agent_instance_operator_index;

        let num_instances = agent_instance_operator_index
            .agent_instance_operator_pda
            .len();
        require!(num_instances > 0, ErrorCode::OperatorHasNoInstances);

        // Update service state
        service.num_agent_instances = service
            .num_agent_instances
            .saturating_sub(num_instances as u32);
        if service.num_agent_instances == 0 {
            service.state = ServiceState::PreRegistration;
        }

        // Refund logic
        let (operator_bond_pda, _operator_bond_bump) = Pubkey::find_program_address(
            &[
                b"operator_bond",
                &service_id.to_le_bytes(),
                &operator.key().to_bytes(),
            ],
            ctx.program_id,
        );

        require!(
            operator_bond_pda == operator_bond.key(),
            ErrorCode::InvalidPda
        );

        let refund: u64 = operator_bond.bond;

        // Only proceed if there's something to refund
        if refund > 0 {
            operator_bond.bond = 0; // wipe the data

            // Transfer lamports back to the operator
            **operator.to_account_info().try_borrow_mut_lamports()? += refund;
            **operator_bond.to_account_info().try_borrow_mut_lamports()? -= refund;

            msg!("Refunded {} lamports to operator", refund);
        }

        ServiceRegistry::close_account(&operator_bond.to_account_info(), &ctx.accounts.user)?;

        // Cleanup all agent instance PDAs for operators
        for agent_instance_operator_pda in agent_instance_operator_index
            .agent_instance_operator_pda
            .iter()
        {
            // Derive the service_agent_instance PDA from the account
            let agent_instance_operator_info =
                next_account_info(&mut ctx.remaining_accounts.iter())?;

            // Validate PDA
            require!(
                agent_instance_operator_pda == &agent_instance_operator_info.key(),
                ErrorCode::InvalidPda
            );

            //  Close agent_instance_operator
            ServiceRegistry::close_account(agent_instance_operator_info, &ctx.accounts.user)?;
        }

        agent_instance_operator_index
            .agent_instance_operator_pda
            .clear();
        if agent_instance_operator_index
            .agent_instance_operator_pda
            .is_empty()
        {
            ServiceRegistry::close_account(
                &agent_instance_operator_index.to_account_info(),
                &ctx.accounts.user,
            )?;
        }

        // Emit event
        emit!(OperatorUnbonded {
            operator: operator.key(),
            service_id,
            refund,
        });

        registry.locked = false;
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

    fn upsert_agent_param_index(vec: &mut Vec<AgentParamAccount>, param: &AgentParamAccount) {
        let param_clone = (*param).clone();
        if let Some(existing) = vec.iter_mut().find(|x| x.agent_id == param.agent_id) {
            *existing = param_clone;
        } else {
            vec.push(param_clone);
        }
    }

    fn delete_agent_param_index(vec: &mut Vec<AgentParamAccount>, agent_id: u32) {
        if let Some(index) = vec.iter().position(|x| x.agent_id == agent_id) {
            vec.remove(index);
        }
    }

    fn validate_threshold(service: &mut ServiceAccount, threshold: Option<u32>) -> Result<()> {
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

    fn check_access_and_state<'info>(
        ctx: &Context<'_, '_, 'info, 'info, RegisterAgentInstances<'info>>,
        registry: &ServiceRegistry,
        service_state: &ServiceState,
        agent_instances: &[Pubkey],
        agent_ids: &[u32],
    ) -> Result<()> {
        if ctx.accounts.user.key() != registry.manager {
            return Err(ProgramError::InvalidAccountOwner.into());
        }

        require!(
            agent_instances.len() == agent_ids.len(),
            ErrorCode::WrongArrayLength
        );

        require!(
            service_state == &ServiceState::ActiveRegistration,
            ErrorCode::WrongServiceState
        );

        Ok(())
    }

    fn load_and_validate_agent_params<'info>(
        remaining_accounts: &mut std::slice::Iter<AccountInfo<'info>>,
        agent_ids: &Vec<u32>,
    ) -> Result<(Vec<AgentParamAccount>, u64)> {
        let mut agent_params = vec![];
        let mut total_bond = 0;

        for _ in agent_ids {
            let agent_param_account_info = next_account_info(remaining_accounts)?;
            let data = agent_param_account_info.try_borrow_data()?;
            let agent_param = AgentParamAccount::try_from_slice(&data[8..])?;

            require!(agent_param.slots > 0, ErrorCode::AgentNotInService);

            total_bond += agent_param.bond;
            agent_params.push(agent_param);
        }

        Ok((agent_params, total_bond))
    }

    fn transfer_bond<'info>(
        program_id: &Pubkey,
        user: &Signer<'info>,
        system_program: &Program<'info, System>,
        registry: &Account<'_, ServiceRegistry>,
        registry_wallet: &AccountInfo<'info>,
        transfer_amount: u64,
    ) -> Result<()> {
        let user_pre_balance = user.lamports();

        require!(
            user_pre_balance >= transfer_amount,
            ErrorCode::IncorrectRegistrationDepositValue
        );

        let (registry_wallet_pda, registry_wallet_bump) = Pubkey::find_program_address(
            &[b"registry_wallet", &registry.key().to_bytes()],
            program_id,
        );

        require_eq!(
            registry_wallet_pda,
            registry_wallet.key(),
            ErrorCode::WrongRegistryWallet
        );

        require_eq!(
            registry_wallet_pda,
            registry.wallet_key,
            ErrorCode::WrongRegistryWallet
        );

        require_eq!(
            registry_wallet_bump,
            registry.wallet_bump,
            ErrorCode::WrongRegistryWallet
        );

        let transfer_tx = transfer(&user.key(), &registry_wallet.key(), transfer_amount);

        invoke_signed(
            &transfer_tx,
            &[
                user.to_account_info(),
                registry_wallet.clone(),
                system_program.to_account_info(),
            ],
            &[&[
                b"registry_wallet",
                registry.key().as_ref(),
                &[registry_wallet_bump],
            ]],
        )?;

        let user_post_balance = user.lamports();

        let balance_diff = user_pre_balance
            .checked_sub(user_post_balance)
            .ok_or(ErrorCode::Overflow)?;

        require!(
            balance_diff == transfer_amount,
            ErrorCode::IncorrectRegistrationDepositValue
        );

        Ok(())
    }

    fn validate_operator<'info>(
        program_id: Pubkey,
        operator: Pubkey,
        remaining_accounts: &mut std::slice::Iter<AccountInfo<'info>>,
    ) -> Result<()> {
        if operator == Pubkey::default() {
            return Err(ProgramError::InvalidArgument.into());
        }

        let (operator_as_agent_pda, _) =
            Pubkey::find_program_address(&[b"agent_instances", &operator.to_bytes()], &program_id);

        let operator_check_account_info = next_account_info(remaining_accounts)?;

        require!(
            operator_as_agent_pda == operator_check_account_info.key(),
            ErrorCode::InvalidPda
        );

        require!(
            operator_check_account_info.data_is_empty(),
            ErrorCode::WrongOperator
        );

        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn register_single_instance<'info>(
        program_id: &Pubkey,
        service: &mut Account<ServiceAccount>,
        agent_id: u32,
        agent_instance: Pubkey,
        agent_param: &AgentParamAccount,
        operator: Pubkey,
        user_account_info: &AccountInfo<'info>,
        system_program_account_info: &AccountInfo<'info>,
        agent_instance_operator_index_account: &mut Account<'info, AgentInstanceOperatorIndex>,
        remaining_accounts: &mut std::slice::Iter<'info, AccountInfo<'info>>,
    ) -> Result<()> {
        let service_id = service.service_id;

        // 1. Global agent_instances
        let (agent_instances_pda, agent_instances_bump) = Pubkey::find_program_address(
            &[
                b"agent_instances",
                &service_id.to_le_bytes(),
                &agent_id.to_le_bytes(),
            ],
            program_id,
        );

        let agent_instances_account_info = next_account_info(remaining_accounts)?;

        require!(
            agent_instances_pda == agent_instances_account_info.key(),
            ErrorCode::InvalidPda
        );

        // Check if the account exists
        let mut agent_instances_data: Account<AgentInstancesAccount>;

        if agent_instances_account_info.data_is_empty() {
            // Create the account if it doesn't exist
            invoke_signed(
                &system_instruction::create_account(
                    &user_account_info.key(),
                    &agent_instances_pda,
                    Rent::get()?.minimum_balance(AgentInstancesAccount::LEN),
                    AgentInstancesAccount::LEN as u64,
                    program_id,
                ),
                &[
                    user_account_info.clone(),
                    agent_instances_account_info.clone(),
                    system_program_account_info.clone(),
                ],
                &[&[
                    b"agent_instances",
                    &service_id.to_le_bytes(),
                    &agent_id.to_le_bytes(),
                    &[agent_instances_bump],
                ]],
            )?;

            // Initialize new empty account
            agent_instances_data = Account::try_from_unchecked(agent_instances_account_info)?;
            agent_instances_data.service_id = service_id;
            agent_instances_data.agent_id = agent_id;
            agent_instances_data.agent_instances = Vec::new();
        } else {
            // Load existing account
            agent_instances_data = Account::try_from_unchecked(agent_instances_account_info)?;
        }

        // Add the new agent instance
        agent_instances_data.agent_instances.push(agent_instance);

        let mut data = agent_instances_account_info.try_borrow_mut_data()?;
        let discriminator =
            &anchor_lang::solana_program::hash::hash("account:AgentInstancesAccount".as_bytes())
                .to_bytes()[..8];
        data[..8].copy_from_slice(discriminator);

        // Serialize the struct after discriminator
        agent_instances_data.serialize(&mut &mut data[8..])?;

        //  2. Slot counter
        let (slot_counter_pda, slot_counter_bump) = Pubkey::find_program_address(
            &[
                b"service_agent_slot",
                &service_id.to_le_bytes(),
                &agent_id.to_le_bytes(),
            ],
            program_id,
        );

        let slot_counter_info = next_account_info(remaining_accounts)?;
        require!(
            slot_counter_pda == slot_counter_info.key(),
            ErrorCode::InvalidPda
        );

        let mut slot_counter: Account<ServiceAgentSlotCounterAccount> =
            if slot_counter_info.data_is_empty() {
                invoke_signed(
                    &system_instruction::create_account(
                        &user_account_info.key(),
                        &slot_counter_pda,
                        Rent::get()?.minimum_balance(1 + 8),
                        1 + 8,
                        program_id,
                    ),
                    &[
                        user_account_info.clone(),
                        slot_counter_info.clone(),
                        system_program_account_info.clone(),
                    ],
                    &[&[
                        b"service_agent_slot",
                        &service_id.to_le_bytes(),
                        &agent_id.to_le_bytes(),
                        &[slot_counter_bump],
                    ]],
                )?;

                Account::<ServiceAgentSlotCounterAccount>::try_from_unchecked(slot_counter_info)?
            } else {
                Account::<ServiceAgentSlotCounterAccount>::try_from_unchecked(slot_counter_info)?
            };

        require!(
            slot_counter.count < agent_param.slots as u8,
            ErrorCode::AgentInstancesSlotsFilled
        );

        slot_counter.count += 1;
        let mut data = slot_counter_info.try_borrow_mut_data()?;
        let discriminator = &anchor_lang::solana_program::hash::hash(
            "account:ServiceAgentSlotCounterAccount".as_bytes(),
        )
        .to_bytes()[..8];
        data[..8].copy_from_slice(discriminator);
        slot_counter.serialize(&mut &mut data[8..])?;

        //  3. service_agent_instance
        let (service_agent_instance_pda, service_agent_instance_bump) =
            Pubkey::find_program_address(
                &[
                    b"service_agent_instance",
                    &service_id.to_le_bytes(),
                    &agent_id.to_le_bytes(),
                    &agent_instance.to_bytes(),
                ],
                program_id,
            );

        let service_agent_instance_account_info = next_account_info(remaining_accounts)?;
        require!(
            service_agent_instance_pda == service_agent_instance_account_info.key(),
            ErrorCode::InvalidPda
        );

        if !service_agent_instance_account_info.data_is_empty() {
            return Err(ErrorCode::AccountServiceAgentIdInstanceExists.into());
        }

        invoke_signed(
            &system_instruction::create_account(
                &user_account_info.key(),
                &service_agent_instance_pda,
                Rent::get()?.minimum_balance(ServiceAgentInstanceAccount::LEN),
                ServiceAgentInstanceAccount::LEN as u64,
                program_id,
            ),
            &[
                user_account_info.clone(),
                service_agent_instance_account_info.clone(),
                system_program_account_info.clone(),
            ],
            &[&[
                b"service_agent_instance",
                &service_id.to_le_bytes(),
                &agent_id.to_le_bytes(),
                &agent_instance.to_bytes(),
                &[service_agent_instance_bump],
            ]],
        )?;

        let mut service_agent_instance_data: Account<ServiceAgentInstanceAccount> =
            Account::try_from_unchecked(service_agent_instance_account_info)?;

        service_agent_instance_data.service_id = service_id;
        service_agent_instance_data.agent_id = agent_id;
        service_agent_instance_data.agent_instance = agent_instance;

        let mut data = service_agent_instance_account_info.try_borrow_mut_data()?;
        let discriminator = &anchor_lang::solana_program::hash::hash(
            "account:ServiceAgentInstanceAccount".as_bytes(),
        )
        .to_bytes()[..8];
        data[..8].copy_from_slice(discriminator);
        service_agent_instance_data.serialize(&mut &mut data[8..])?;

        //  4. agent_instance_operator
        let (agent_instance_operator_pda, agent_instance_operator_bump) =
            Pubkey::find_program_address(
                &[
                    b"agent_instance_operator",
                    &agent_instance.to_bytes(),
                    &operator.to_bytes(),
                ],
                program_id,
            );

        let agent_instance_operator_account_info = next_account_info(remaining_accounts)?;
        require!(
            agent_instance_operator_pda == agent_instance_operator_account_info.key(),
            ErrorCode::InvalidPda
        );

        if !agent_instance_operator_account_info.data_is_empty() {
            return Err(ErrorCode::AccountAgentIdInstanceOperatorExists.into());
        }

        invoke_signed(
            &system_instruction::create_account(
                &user_account_info.key(),
                &agent_instance_operator_pda,
                Rent::get()?.minimum_balance(AgentInstanceOperatorAccount::LEN),
                AgentInstanceOperatorAccount::LEN as u64,
                program_id,
            ),
            &[
                user_account_info.clone(),
                agent_instance_operator_account_info.clone(),
                system_program_account_info.clone(),
            ],
            &[&[
                b"agent_instance_operator",
                &agent_instance.to_bytes(),
                &operator.to_bytes(),
                &[agent_instance_operator_bump],
            ]],
        )?;

        let mut agent_instance_operator_data: Account<AgentInstanceOperatorAccount> =
            Account::try_from_unchecked(agent_instance_operator_account_info)?;
        agent_instance_operator_data.operator = operator;
        agent_instance_operator_data.service_agent_instance_pda = service_agent_instance_pda;

        let mut data = agent_instance_operator_account_info.try_borrow_mut_data()?;
        let discriminator = &anchor_lang::solana_program::hash::hash(
            "account:AgentInstanceOperatorAccount".as_bytes(),
        )
        .to_bytes()[..8];
        data[..8].copy_from_slice(discriminator);
        agent_instance_operator_data.serialize(&mut &mut data[8..])?;

        service.num_agent_instances += 1;
        require!(
            service.num_agent_instances <= service.max_num_agent_instances,
            ErrorCode::IncorrectAgentInstances
        );

        //  Push in agent_instance_operator_index
        let (agent_instance_operator_pda, _aagent_instance_operator_bump) =
            Pubkey::find_program_address(
                &[
                    b"agent_instance_operator_index",
                    &service.service_id.to_le_bytes(),
                ],
                program_id,
            );

        require!(
            agent_instance_operator_pda == agent_instance_operator_index_account.key(),
            ErrorCode::InvalidPda
        );

        require!(
            agent_instance_operator_index_account
                .agent_instance_operator_pda
                .len()
                < MAX_AGENT_INSTANCES_PER_SERVICE,
            ErrorCode::MaxAgentInstancesPerServiceReached
        );

        agent_instance_operator_index_account
            .agent_instance_operator_pda
            .push(agent_instance_operator_pda);

        emit!(RegisterInstance {
            operator,
            service_id,
            agent_instance,
            agent_id,
        });

        Ok(())
    }

    fn update_operator_bond<'info>(
        program_id: &Pubkey,
        operator: Pubkey,
        service_id: u128,
        total_bond: u64,
        user_account_info: &AccountInfo<'info>,
        operator_bond_account_info: &'info AccountInfo<'info>,
        system_program_account_info: &AccountInfo<'info>,
    ) -> Result<()> {
        let (operator_bond_pda, operator_bond_bump) = Pubkey::find_program_address(
            &[
                b"operator_bond",
                &service_id.to_le_bytes(),
                &operator.to_bytes(),
            ],
            program_id,
        );

        require!(
            operator_bond_pda == operator_bond_account_info.key(),
            ErrorCode::InvalidPda
        );

        if operator_bond_account_info.data_is_empty() {
            invoke_signed(
                &system_instruction::create_account(
                    &user_account_info.key(),
                    &operator_bond_pda,
                    Rent::get()?.minimum_balance(OperatorBondAccount::LEN),
                    OperatorBondAccount::LEN as u64,
                    program_id,
                ),
                &[
                    user_account_info.clone(),
                    operator_bond_account_info.clone(),
                    system_program_account_info.clone(),
                ],
                &[&[
                    b"operator_bond",
                    &service_id.to_le_bytes(),
                    &operator.to_bytes(),
                    &[operator_bond_bump],
                ]],
            )?;
        }

        let mut operator_bond_data: Account<OperatorBondAccount> =
            Account::try_from_unchecked(operator_bond_account_info)?;

        operator_bond_data.service_id = service_id;
        operator_bond_data.operator = operator;
        operator_bond_data.bond += total_bond;

        let mut data = operator_bond_account_info.try_borrow_mut_data()?;
        let discriminator =
            &anchor_lang::solana_program::hash::hash("account:OperatorBondAccount".as_bytes())
                .to_bytes()[..8];
        data[..8].copy_from_slice(discriminator);
        operator_bond_data.serialize(&mut &mut data[8..])?;

        emit!(Deposit {
            operator,
            amount: total_bond,
        });

        Ok(())
    }

    fn close_account<'info>(
        account: &AccountInfo<'info>,
        refund_to: &AccountInfo<'info>,
    ) -> Result<()> {
        let lamports = account.lamports();
        if lamports > 0 {
            **refund_to.try_borrow_mut_lamports()? += lamports;
            **account.try_borrow_mut_lamports()? = 0;
        }
        account.data.borrow_mut().fill(0);
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = REGISTRY_ACCOUNT_SIZE)]
    pub registry: Account<'info, ServiceRegistry>,
    /// CHECK: PDA wallet owned by the program
    #[account(
            init,
            payer = user,
            space = 8,
            seeds = [b"registry_wallet", registry.key().as_ref()],
            bump
        )]
    pub registry_wallet: AccountInfo<'info>,
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
pub struct RegisterAgentIdsToService<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,

    #[account(mut)]
    pub service: Account<'info, ServiceAccount>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + (MAX_AGENT_IDS_PER_SERVICE * AgentParamAccount::LEN) + 8, // 8 bytes for Vec metadata + data for MAX_AGENT_IDS_PER_SERVICE u32 agent IDs + 8 bytes Vec overhead
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
    #[account(mut, address = registry.owner)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct CheckService<'info> {
    #[account(mut)]
    pub service: Account<'info, ServiceAccount>,

    #[account(
        seeds = [b"service_agent_ids_index", &service.service_id.to_le_bytes()[..]],
        bump,
    )]
    pub service_agent_ids_index: Account<'info, ServiceAgentIdsIndex>,
}

#[derive(Accounts)]
pub struct ActivateRegistration<'info> {
    pub registry: Account<'info, ServiceRegistry>,

    #[account(mut)]
    pub service: Account<'info, ServiceAccount>,

    /// CHECK: PDA wallet owned by the program
    #[account(mut)]
    pub registry_wallet: AccountInfo<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct RegisterAgentInstances<'info> {
    pub registry: Account<'info, ServiceRegistry>,

    #[account(mut)]
    pub service: Account<'info, ServiceAccount>,

    /// CHECK: PDA wallet owned by the program
    #[account(mut)]
    pub registry_wallet: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = user,
        space = 8 + (MAX_AGENT_INSTANCES_PER_SERVICE * PUBKEY_SIZE) + 8, // 8 bytes for Vec metadata + data for MAX_AGENT_INSTANCES_PER_SERVICE PUBKEY_SIZE agent_instance_operator_pda PDA + 8 bytes Vec overhead
        seeds = [b"agent_instance_operator_index", &service.service_id.to_le_bytes()[..]],
        bump,
    )]
    pub agent_instance_operator_index: Account<'info, AgentInstanceOperatorIndex>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TerminateService<'info> {
    pub registry: Account<'info, ServiceRegistry>,
    #[account(mut)]
    pub service: Account<'info, ServiceAccount>,

    #[account(
        mut,
        seeds = [b"service_agent_ids_index", &service.service_id.to_le_bytes()[..]],
        bump,
    )]
    pub service_agent_ids_index: Account<'info, ServiceAgentIdsIndex>,

    /// CHECK: PDA wallet owned by the program
    #[account(mut)]
    pub registry_wallet: AccountInfo<'info>,

    #[account(mut)]
    pub service_owner: Signer<'info>,

    #[account(mut, signer)]
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct UnbondOperator<'info> {
    pub registry: Account<'info, ServiceRegistry>,

    #[account(mut)]
    pub service: Account<'info, ServiceAccount>,

    #[account(
        mut,
        seeds = [b"agent_instance_operator_index", &service.service_id.to_le_bytes()[..]],
        bump,
    )]
    pub agent_instance_operator_index: Account<'info, AgentInstanceOperatorIndex>,

    #[account(mut, close = operator)]
    pub operator_bond: Account<'info, OperatorBondAccount>,

    #[account(mut)]
    pub operator: Signer<'info>,

    #[account(mut)]
    pub user: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct DummyContextForAgentParam<'info> {
    pub agent_param_account: Account<'info, AgentParamAccount>,
}

#[derive(Accounts)]
pub struct DummyReadAgentInstances<'info> {
    #[account()]
    pub agent_instance_account: Account<'info, AgentInstancesAccount>,
}

#[derive(Accounts)]
pub struct DummyAgentInstanceOperatorAccount<'info> {
    #[account()]
    pub agent_instance_operator_account: Account<'info, AgentInstanceOperatorAccount>,
}

#[derive(Accounts)]
pub struct DummyServiceAgentInstanceAccount<'info> {
    #[account()]
    pub service_agent_instance_account: Account<'info, ServiceAgentInstanceAccount>,
}

#[derive(Accounts)]
pub struct DummyServiceAgentSlotCounterAccount<'info> {
    #[account()]
    pub service_agent_slot_counter_account: Account<'info, ServiceAgentSlotCounterAccount>,
}

#[derive(Accounts)]
pub struct DummyOperatorBondAccount<'info> {
    #[account()]
    pub agent_operator_bond_account: Account<'info, OperatorBondAccount>,
}
