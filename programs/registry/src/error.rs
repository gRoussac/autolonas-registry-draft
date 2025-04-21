use anchor_lang::error_code;

#[error_code]
pub enum ErrorCode {
    #[msg("Service not found")]
    ServiceNotFound,
    #[msg("Service space is not enough")]
    NotEnoughSpace,
    #[msg("Config hash cannot be zero")]
    ZeroConfigHash,
    #[msg("Slots or bond cannot be zero")]
    ZeroValue,
    #[msg("Agent ID list is empty or lengths do not match")]
    WrongArrayLength,
    #[msg("Agent IDs must be strictly increasing and without duplicates")]
    WrongAgentId,
    #[msg("Threshold is below allowed bounds")]
    WrongThreshold,

    #[msg("Threshold is above allowed bounds")]
    WrongThreshold2,

    #[msg("Reentrancy guard")]
    ReentrancyGuard,

    #[msg("Wrong service state")]
    WrongServiceState,

    #[msg("Invalid PDA")]
    InvalidPda,

    #[msg("Service/Agent does not exist")]
    ServiceAgentDoesNotExist,
    #[msg("Service/Agent invalid")]
    InvalidServiceAgentPda,

    #[msg("Agent/Param does not exist")]
    AgentParamDoesNotExist,
    #[msg("Agent/Param is invalid")]
    InvalidAgentParamPda,

    #[msg("Invalid account owner")]
    InvalidAccountOwner,

    #[msg("Service must be active")]
    ServiceMustBeInactive,

    #[msg("Incorrect registration deposit value")]
    IncorrectRegistrationDepositValue,
}
