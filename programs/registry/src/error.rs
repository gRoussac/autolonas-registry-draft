use anchor_lang::error_code;

#[error_code]
pub enum ErrorCode {
    #[msg("Service not found")]
    ServiceNotFound,
    #[msg("Service space is not enough")]
    NotEnoughSpace,
    #[msg("Config hash cannot be zero")]
    ZeroConfigHash,
    #[msg("Slots or bond cannot be zero.")]
    ZeroValue,
    #[msg("Agent ID list is empty or lengths do not match")]
    WrongArrayLength,
    #[msg("Agent IDs must be strictly increasing and without duplicates")]
    WrongAgentId,
    #[msg("Threshold is below allowed bounds.")]
    WrongThreshold,

    #[msg("Threshold is above allowed bounds.")]
    WrongThreshold2,

    #[msg("Reentrancy guard")]
    ReentrancyGuard,

    #[msg("Wrong service state")]
    WrongServiceState,
}
