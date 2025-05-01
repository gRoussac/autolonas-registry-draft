pub const MAX_AGENT_IDS_PER_SERVICE: usize = 128;
pub const MAX_AGENT_INSTANCES_PER_SERVICE: usize = 192;

pub const STRING_PREFIX_SIZE: usize = 4;
pub const MAX_NAME_LENGTH: usize = 256;
pub const MAX_SYMBOL_LENGTH: usize = 64;
pub const MAX_URI_LENGTH: usize = 512;
pub const PUBKEY_SIZE: usize = 32;
pub const U64_SIZE: usize = 8;
pub const U128_SIZE: usize = 16;
pub const BOOL_SIZE: usize = 1;
pub const U8_SIZE: usize = 1;
pub const FIXED_SIZE: usize = 32;

pub const REGISTRY_ACCOUNT_SIZE: usize = STRING_PREFIX_SIZE // name prefix
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
