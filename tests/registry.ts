import * as anchor from '@coral-xyz/anchor';
import { Program } from '@coral-xyz/anchor';
import { Registry } from '../target/types/registry';

describe('registry', () => {
  anchor.setProvider(anchor.AnchorProvider.env());

  const program = anchor.workspace.registry as Program<Registry>;
  const name = 'test_token';
  const symbol = 'AUTO';
  const base_uri = 'base_uri';

  const owner = anchor.web3.Keypair.generate();
  const manager = anchor.web3.Keypair.generate();
  const drainer = anchor.web3.Keypair.generate().publicKey;

  it('Is initialized!', async () => {
    const registryAccount = anchor.web3.Keypair.generate();

    // Airdrop SOL to owner
    const connection = anchor.getProvider().connection;
    const airdropSignature = await connection.requestAirdrop(
      owner.publicKey,
      1e9
    );
    await connection.confirmTransaction(airdropSignature);

    const tx = await program.methods
      .initialize(name, symbol, base_uri, manager.publicKey, drainer)
      .accounts({
        registry: registryAccount.publicKey, // Registry account
        user: owner.publicKey, // The owner is now the payer
      })
      .signers([owner, registryAccount])
      .rpc();
    console.info('Your transaction signature', tx);
  });

  it('Initializes and creates two services', async () => {
    const registryAccount = anchor.web3.Keypair.generate();

    const ownerService = anchor.web3.Keypair.generate();

    const connection = anchor.getProvider().connection;
    const airdropSignature = await connection.requestAirdrop(
      owner.publicKey,
      2e9
    );
    await connection.confirmTransaction(airdropSignature);

    await program.methods
      .initialize(name, symbol, base_uri, manager.publicKey, drainer)
      .accounts({
        registry: registryAccount.publicKey,
        user: owner.publicKey,
      })
      .signers([owner, registryAccount])
      .rpc();

    console.info('Initialized registry');

    const threshold = 8; // 7 << threshold << 10
    let agent_ids_per_service = 10;

    // Define agent_ids and agent_params
    const agent_ids: number[] = Array.from(
      { length: agent_ids_per_service },
      (_, i) => i + 1
    );
    const agent_params = agent_ids.map((id) => ({
      slots: 1,
      bond: new anchor.BN(1000),
    }));

    // console.info(agent_ids);
    // console.info(agent_params);

    // First service
    await program.methods
      .create(
        ownerService.publicKey,
        Array.from(new Uint8Array(32).fill(1)), // config_hash
        agent_ids,
        agent_params,
        threshold,
        anchor.web3.Keypair.generate().publicKey // multisig
      )
      .accounts({
        registry: registryAccount.publicKey,
        user: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    console.info('Created first service');

    agent_ids_per_service = 20;

    // Second service
    await program.methods
      .create(
        ownerService.publicKey,
        Array.from(new Uint8Array(32).fill(2)), // config_hash
        agent_ids,
        agent_params,
        threshold,
        anchor.web3.Keypair.generate().publicKey // multisig
      )
      .accounts({
        registry: registryAccount.publicKey,
        user: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    console.info('Created second service');
  });
});
