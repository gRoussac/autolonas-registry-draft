use anchor_lang::prelude::*;

pub mod error;
use error::ErrorCode;

declare_id!("9Q2mQxDLH91HLaQUYyxV5n9WhA1jzgVThJwfJTNqEUNP");

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct AgentParams {
    pub slots: u32,
    pub bond: u128,
}

#[account]
pub struct ServiceRegistry {
    pub name: String,
    pub symbol: String,
    pub base_uri: String,
    pub owner: Pubkey,
    pub manager: Pubkey,
    pub drainer: Pubkey,
    pub slashed_funds: u64,
    pub services: Vec<Service>,
    pub total_supply: u128,
    pub version: String,
    pub locked: bool,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Default)]
pub struct Service {
    pub service_id: u128,
    pub owner: Pubkey,
    pub security_deposit: u128,
    pub multisig: Pubkey,
    pub config_hash: [u8; 32],
    pub threshold: u32,
    pub max_num_agent_instances: u32,
    pub num_agent_instances: u32,
    pub state: ServiceState,
    pub agent_ids: Vec<u32>,
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

#[program]
pub mod registry {
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
        service_owner: Pubkey,
        config_hash: [u8; 32],
        agent_ids: Vec<u32>,
        agent_params: Vec<AgentParams>,
        threshold: u32,
        multisig: Pubkey,
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

        ServiceRegistry::initial_checks(config_hash, &agent_ids, &agent_params)?;

        for (_, params) in agent_ids.iter().zip(agent_params.iter()) {
            if params.slots == 0 || params.bond == 0 {
                return Err(ErrorCode::ZeroValue.into());
            }
        }

        let service_id = registry.total_supply + 1;

        // We use service_id as num_services to calculate space required
        let total_space_needed = ServiceRegistry::calculate_space(service_id, agent_ids.len());

        if registry.to_account_info().data_len() < total_space_needed {
            return Err(ErrorCode::NotEnoughSpace.into());
        }

        let mut service = Service {
            service_id,
            owner: service_owner,
            security_deposit: 0,
            multisig,
            config_hash,
            threshold,
            max_num_agent_instances: 0,
            num_agent_instances: 0,
            state: ServiceState::PreRegistration,
            agent_ids: Vec::default(),
        };

        ServiceRegistry::set_service_data(&mut service, &agent_ids, &agent_params)?;

        registry.add_service(service);

        emit!(CreateServiceEvent {
            service_id,
            config_hash
        });

        registry.locked = false;

        Ok(())
    }

    pub fn update(
        ctx: Context<UpdateService>,
        service_owner: Pubkey,
        config_hash: [u8; 32],
        agent_ids: Vec<u32>,
        agent_params: Vec<AgentParams>,
        threshold: u32,
        service_id: u128,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;

        // Check manager privilege
        if ctx.accounts.user.key() != registry.manager {
            return Err(ProgramError::IllegalOwner.into());
        }

        // Get mutable reference to the service
        let service = registry
            .get_service_mut(service_id)
            .ok_or(ErrorCode::ServiceNotFound)?;

        // Check for service ownership
        if service.owner != service_owner {
            return Err(Error::from(ProgramError::InvalidAccountOwner));
        }

        // Check state is PreRegistration
        if service.state != ServiceState::PreRegistration {
            return Err(ErrorCode::WrongServiceState.into());
        }

        // Re-run initial service checks
        ServiceRegistry::initial_checks(config_hash, &agent_ids, &agent_params)?;

        // Prepare new lists for updated agent_ids and agent_params
        let mut new_agent_ids: Vec<u32> = Vec::with_capacity(agent_ids.len());
        let mut new_agent_params: Vec<AgentParams> = Vec::with_capacity(agent_ids.len());

        for (agent_id, params) in agent_ids.iter().zip(agent_params.iter()) {
            if params.slots == 0 {
                // Simulated deletion of service-agent param entry
                // ! TODO
                // map_service_and_agent_params.remove(service_id, *agent_id);
            } else {
                new_agent_ids.push(*agent_id);
                new_agent_params.push(params.clone());
            }
        }

        // If config hash changed, archive previous one
        if service.config_hash != config_hash {
            // registry.push_old_config_hash(service_id, service.config_hash);
            service.config_hash = config_hash;
        }

        // Update the threshold
        service.threshold = threshold;

        // Reset agent instance tracking
        service.max_num_agent_instances = 0;

        // Update canonical agent list
        ServiceRegistry::set_service_data(service, &new_agent_ids, &new_agent_params)?;

        emit!(UpdateServiceEvent {
            service_id,
            config_hash
        });

        Ok(())
    }

    pub fn register_agents(
        ctx: Context<UpdateService>,
        service_id: u128,
        new_agents: Vec<u32>,
    ) -> Result<()> {
        let registry = &mut ctx.accounts.registry;
        let total_supply = registry.total_supply;

        let service = registry
            .get_service_mut(service_id)
            .ok_or(ErrorCode::ServiceNotFound)?;

        service.agent_ids.extend(new_agents.iter());
        service.num_agent_instances = service.agent_ids.len() as u32;

        let agent_ids_len = service.agent_ids.len();

        let total_space_needed = ServiceRegistry::calculate_space(total_supply, agent_ids_len);

        if registry.to_account_info().data_len() < total_space_needed {
            return Err(ErrorCode::NotEnoughSpace.into());
        }

        Ok(())
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
}

impl ServiceRegistry {
    pub fn initial_checks(
        config_hash: [u8; 32],
        agent_ids: &[u32],
        agent_params: &[AgentParams],
    ) -> Result<()> {
        // Check for zero config hash
        if config_hash == [0u8; 32] {
            return Err(ErrorCode::ZeroConfigHash.into());
        }

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

        Ok(())
    }

    pub fn set_service_data(
        service: &mut Service,
        agent_ids: &[u32],
        agent_params: &[AgentParams],
    ) -> Result<()> {
        if agent_ids.len() != agent_params.len() {
            return Err(ErrorCode::WrongArrayLength.into());
        }

        let mut security_deposit: u128 = 0;
        service.agent_ids = Vec::with_capacity(agent_ids.len());

        for i in 0..agent_ids.len() {
            let agent_id = agent_ids[i];
            let params = &agent_params[i];

            service.agent_ids.push(agent_id);

            // // Compose 64-bit key: lower 32 bits = service.service_id, upper 32 bits = agent_id
            // let service_agent: u128 = (agent_id as u128) << 32 | (service.service_id & 0xFFFFFFFF);
            // ! TODO
            // map_service_and_agent_params.insert(service_agent, params.clone());

            service.max_num_agent_instances =
                service.max_num_agent_instances.saturating_add(params.slots);

            // Update security deposit to max bond
            if params.bond > security_deposit {
                security_deposit = params.bond;
            }
        }

        service.security_deposit = security_deposit;

        // Check that threshold is within valid range
        let check_threshold = (service.max_num_agent_instances as u128 * 2 + 1).div_ceil(3); // ceiling division

        if (service.threshold as u128) < check_threshold {
            return Err(ErrorCode::WrongThreshold.into());
        }

        if (service.threshold as u128) > service.max_num_agent_instances as u128 {
            return Err(ErrorCode::WrongThreshold2.into());
        }

        Ok(())
    }

    pub fn get_service(&self, id: u128) -> Option<&Service> {
        self.services.iter().find(|e| e.service_id == id)
    }

    pub fn get_service_mut(&mut self, id: u128) -> Option<&mut Service> {
        self.services.iter_mut().find(|e| e.service_id == id)
    }

    pub fn add_service(&mut self, service: Service) {
        self.services.push(service);
        self.total_supply += 1;
    }

    /// Calculates the space required to store a `ServiceRegistry` account,
    ///
    /// # Parameters
    /// - `num_services`: The number of services expected in the registry.
    /// - `agent_ids_per_service`: The maximum number of agent IDs per service.
    ///
    /// # Returns
    /// The total space in bytes as a `usize`.
    pub fn calculate_space(num_services: u128, agent_ids_per_service: usize) -> usize {
        // === 1. Account Discriminator ===
        let account_discriminator_size: usize = 8;

        // === 2. Fixed fields in ServiceRegistry ===
        let pubkey_size: usize = 32;
        let u64_size: usize = 8;
        let u128_size: usize = 16;

        let owner_field = pubkey_size;
        let manager_field = pubkey_size;
        let drainer_field = pubkey_size;
        let slashed_funds_field = u64_size;
        let total_supply_field = u128_size;

        // Variable-size fields (name, symbol, base_uri, version): estimate with padding if needed
        let max_string_length = 64; // expect longer strings ?
        let string_field_size = 4 + max_string_length; // Anchor strings = 4 (len prefix) + content
        let name_field = string_field_size;
        let symbol_field = string_field_size;
        let base_uri_field = string_field_size;
        let version_field = string_field_size;

        // Locked: bool = 1 byte
        let locked_field = 1;

        // === 3. Vec<Service> overhead ===
        let vec_metadata_size = 4 + 4 + 4; // Anchor Vec<T>: pointer (4) + length (4) + capacity (4)

        // === 4. Fields in each Service struct ===
        let service_id_field = u128_size;
        let service_owner_field = pubkey_size;
        let security_deposit_field = u128_size;
        let multisig_field = pubkey_size;
        let config_hash_field = 32; // [u8; 32]
        let threshold_field = 4;
        let max_num_agent_instances_field = 4;
        let num_agent_instances_field = 4;
        let state_field = 1;

        // Vec<u32>: agent_ids
        let agent_ids_vec_metadata = 4 + 4 + 4; // pointer, len, cap
        let agent_ids_vec_content = agent_ids_per_service * 4; // u32 = 4 bytes

        let single_service_size = service_id_field
            + service_owner_field
            + security_deposit_field
            + multisig_field
            + config_hash_field
            + threshold_field
            + max_num_agent_instances_field
            + num_agent_instances_field
            + state_field
            + agent_ids_vec_metadata
            + agent_ids_vec_content;

        // === Final Total ===
        account_discriminator_size
            + owner_field
            + manager_field
            + drainer_field
            + slashed_funds_field
            + total_supply_field
            + name_field
            + symbol_field
            + base_uri_field
            + version_field
            + locked_field
            + vec_metadata_size
            + (num_services as usize * single_service_size)
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    // ! TODO
    // 10 services with 10 agents provisonned
    #[account(init, payer = user, space = 8 + ServiceRegistry::calculate_space(10, 10))]
    pub registry: Account<'info, ServiceRegistry>,

    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateService<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateService<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,
    pub user: Signer<'info>,
}

#[derive(Accounts)]
pub struct ChangeDrainer<'info> {
    #[account(mut)]
    pub registry: Account<'info, ServiceRegistry>,
    pub user: Signer<'info>,
}
