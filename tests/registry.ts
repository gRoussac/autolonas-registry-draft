import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { Registry } from '../target/types/registry';
import { assert, expect } from 'chai';

const program = anchor.workspace.registry as Program<Registry>;
const provider = anchor.AnchorProvider.env();
anchor.setProvider(provider);
const connection = anchor.getProvider().connection;

describe('registry', () => {
  const name = 'test_token';
  const symbol = 'AUTO';
  const base_uri = 'base_uri';

  const ownerRegistry = anchor.web3.Keypair.generate();
  const manager = anchor.web3.Keypair.generate();
  const drainer = anchor.web3.Keypair.generate().publicKey;
  const ownerService = anchor.web3.Keypair.generate();

  it('Initializes Registry', async () => {
    const registryAccount = anchor.web3.Keypair.generate();

    // Airdrop SOL to owner
    const airdropSignature = await connection.requestAirdrop(
      ownerRegistry.publicKey,
      200 * anchor.web3.LAMPORTS_PER_SOL
    );
    await connection.confirmTransaction(airdropSignature);

    const tx = await program.methods
      .initialize(name, symbol, base_uri, manager.publicKey, drainer)
      .accounts({
        registry: registryAccount.publicKey, // Registry account
        user: ownerRegistry.publicKey, // The owner is now the payer
      })
      .signers([ownerRegistry, registryAccount])
      .rpc();
    // console.info('Your transaction signature', tx);

    const [expectedPda, expectedBump] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('registry_wallet'), registryAccount.publicKey.toBytes()],
        program.programId
      );

    const registryData = await program.account.serviceRegistry.fetch(
      registryAccount.publicKey
    );

    // Check that the wallet_pda stored in the registry matches the expected PDA
    assert.equal(
      registryData.walletKey.toString(),
      expectedPda.toString(),
      'The wallet PDA is not correct'
    );

    // Check that the wallet_bump stored in the registry matches the expected bump
    assert.equal(
      registryData.walletBump,
      expectedBump,
      'The wallet bump is not correct'
    );
  });

  describe('Service Registry Tests', () => {
    let registryAccount: anchor.web3.Keypair;

    before(async function () {
      registryAccount = anchor.web3.Keypair.generate();

      // Airdrop to ownerRegistry
      let airdropSignature = await connection.requestAirdrop(
        ownerRegistry.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSignature);

      // Initialize the registry
      await program.methods
        .initialize(name, symbol, base_uri, manager.publicKey, drainer)
        .accounts({
          registry: registryAccount.publicKey,
          user: ownerRegistry.publicKey,
        })
        .signers([ownerRegistry, registryAccount])
        .rpc();

      airdropSignature = await connection.requestAirdrop(
        manager.publicKey,
        40 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSignature);

      airdropSignature = await connection.requestAirdrop(
        ownerService.publicKey,
        20 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSignature);
    });

    it('Creates two services with several agents', async () => {
      let agent_ids_per_service = 9;
      const threshold = 7; // 7 << threshold << 9

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

      const config_hash = new Uint8Array(32).fill(1);

      const [servicePda, _bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service'),
          Buffer.from(config_hash.buffer, config_hash.byteOffset, 7),
        ],
        program.programId
      );

      // Create first service
      await program.methods
        .create(Array.from(config_hash), ownerService.publicKey, null)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      // console.info(servicePda);
      // console.info(ownerService.publicKey);

      // FETCH THE SERVICE ACCOUNT FROM CHAIN
      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // Get the actual dynamic service_id from the on-chain account
      const serviceId = serviceAccount.serviceId;

      //console.info(serviceId);

      // Add agents params
      const paramPdas = [];
      // Loop through agentIds to generate all the agent_param_pda addresses
      for (let i = 0; i < agent_ids.length; i++) {
        const agentId = new anchor.BN(agent_ids[i]);

        const [agent_param_pda, _bump] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from('agent_param'),
              serviceId.toArrayLike(Buffer, 'le', 16), // service_id as little-endian 16 bytes
              agentId.toArrayLike(Buffer, 'le', 4), // agent_id as little-endian 4 bytes
            ],
            program.programId
          );

        paramPdas.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      // console.debug(paramPdas);

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda, // The service account (PDA) to add agents
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agents
            user: manager.publicKey, // The manager of the registry (signer)
          })
          .remainingAccounts([
            ...paramPdas.map((pda) => ({
              // params pdas to create or update
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            })),
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error('Transaction failed:', error);
      }

      // Second service
      const second_config_hash = new Uint8Array(32).fill(2);

      const [second_servicePda, second__bump] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service'),
            Buffer.from(
              second_config_hash.buffer,
              second_config_hash.byteOffset,
              7
            ),
          ],
          program.programId
        );

      await program.methods
        .create(
          Array.from(second_config_hash),
          ownerService.publicKey,
          threshold
        )
        .accounts({
          registry: registryAccount.publicKey,
          service: second_servicePda,
          user: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      // console.info('Created second service');
    });

    it('Registers 9 agents ids, then removes 8 of them', async function () {
      let agent_ids_per_service = 9;
      let threshold = 7; // 7 << threshold << 9

      const securityDeposit = 1000;

      const agent_ids = Array.from(
        { length: agent_ids_per_service },
        (_, i) => i + 1
      );
      const agent_params = agent_ids.map((_value, index) => ({
        slots: 1,
        bond: new anchor.BN(securityDeposit * (index + 1)),
      }));

      const config_hash = new Uint8Array(32).fill(3); // Unique config for this test

      const [servicePda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('service'), config_hash.slice(0, 7)],
        program.programId
      );

      try {
        await program.methods
          .create(Array.from(config_hash), ownerService.publicKey, null)
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            user: manager.publicKey,
          })
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);
      const serviceId = serviceAccount.serviceId;

      const pdaList = [];

      for (const agent_id of agent_ids) {
        const agentBN = new anchor.BN(agent_id);
        const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
        const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

        const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
          program.programId
        );
        pdaList.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agen
            user: manager.publicKey,
          })
          .remainingAccounts([
            ...pdaList.map((pda) => ({
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            })),
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      // --- Remove agents ---
      const NewSecurityDeposit = securityDeposit * 10;
      const updated_params = agent_ids.slice(0, 8).map(() => ({
        slots: 0, // Removes the agent
        bond: new anchor.BN(0),
      }));
      updated_params.push({
        slots: 2,
        bond: new anchor.BN(NewSecurityDeposit),
      });

      const updatedPdas = [];

      for (const agent_id of agent_ids) {
        const agentBN = new anchor.BN(agent_id);
        const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
        const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

        const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
          program.programId
        );
        updatedPdas.push(agent_param_pda);
      }

      threshold = 2; // 1 service, 2 slots => threshold = 2

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            updated_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agen
            user: manager.publicKey,
          })
          .remainingAccounts(
            updatedPdas.map((pda) => ({
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            }))
          )
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      const updatedServiceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // console.info(
      //   'max_num_agent_instances',
      //   updatedServiceAccount.maxNumAgentInstances
      // );
      // console.info(
      //   'security_deposit',
      //   updatedServiceAccount.securityDeposit.toNumber()
      // );
      // console.info('threshold', updatedServiceAccount.threshold);

      // Check max_num_agent_instances and security_deposit
      expect(updatedServiceAccount.maxNumAgentInstances).to.equal(2);
      expect(updatedServiceAccount.securityDeposit.toNumber()).to.equal(
        NewSecurityDeposit
      );
      expect(updatedServiceAccount.threshold).to.equal(threshold);
    });

    it('Registers 3 agents ids, then removes 1 of them', async function () {
      const agent_ids_per_service = 3;
      let threshold = 3;

      const securityDeposit = 1000;

      const agent_ids = Array.from(
        { length: agent_ids_per_service },
        (_, i) => i + 1
      );
      const agent_params = agent_ids.map((_value, index) => ({
        slots: 1,
        bond: new anchor.BN(securityDeposit * (index + 1)),
      }));

      // console.debug(JSON.stringify(agent_params));

      const config_hash = new Uint8Array(32).fill(4); // Unique config for this test

      const [servicePda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service'),
          Buffer.from(config_hash.buffer, config_hash.byteOffset, 7),
        ],
        program.programId
      );

      try {
        await program.methods
          .create(Array.from(config_hash), ownerService.publicKey, null)
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            user: manager.publicKey,
          })
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);
      const serviceId = serviceAccount.serviceId;

      // console.info(serviceId);

      const pdaList = [];

      for (const agent_id of agent_ids) {
        const agentBN = new anchor.BN(agent_id);
        const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
        const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

        const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
          program.programId
        );
        pdaList.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agent
            user: manager.publicKey,
          })
          .remainingAccounts([
            ...pdaList.map((pda) => ({
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            })),
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      // --- Remove agents ---

      // console.debug(agent_ids);
      const updated_params = agent_ids.slice(0, 1).map(() => ({
        slots: 0, // Removes the agent
        bond: new anchor.BN(0),
      }));

      // console.debug(updated_params);

      const updatedPdas = [];
      const agentBN = new anchor.BN('1');
      const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
      const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

      const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
        program.programId
      );
      updatedPdas.push(agent_param_pda);

      // console.debug(updatedPdas);

      threshold--;

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids.slice(0, 1),
            updated_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agent
            user: manager.publicKey,
          })
          .remainingAccounts(
            updatedPdas.map((pda) => ({
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            }))
          )
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      const updatedServiceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // console.info(
      //   'max_num_agent_instances',
      //   updatedServiceAccount.maxNumAgentInstances
      // );
      // console.info(
      //   'security_deposit',
      //   updatedServiceAccount.securityDeposit.toNumber()
      // );
      // console.info('threshold', updatedServiceAccount.threshold);

      // Check max_num_agent_instances and security_deposit
      expect(updatedServiceAccount.maxNumAgentInstances).to.equal(
        agent_ids_per_service - 1
      );
      expect(updatedServiceAccount.securityDeposit.toNumber()).to.equal(3000);
      expect(updatedServiceAccount.threshold).to.equal(threshold);
    });

    it('Registers 2 agents ids, then adds 1 of them', async function () {
      const agent_ids_per_service = 2;
      let threshold = 2;

      const securityDeposit = 1000;

      const agent_ids = Array.from(
        { length: agent_ids_per_service },
        (_, i) => i + 1
      );
      const agent_params = agent_ids.map((_value, index) => ({
        slots: 1,
        bond: new anchor.BN(securityDeposit * (index + 1)),
      }));

      // console.debug(JSON.stringify(agent_params));

      const config_hash = new Uint8Array(32).fill(5); // Unique config for this test

      const [servicePda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('service'), config_hash.slice(0, 7)],
        program.programId
      );

      try {
        await program.methods
          .create(Array.from(config_hash), ownerService.publicKey, null)
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            user: manager.publicKey,
          })
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);
      const serviceId = serviceAccount.serviceId;

      const pdaList = [];

      for (const agent_id of agent_ids) {
        const agentBN = new anchor.BN(agent_id);
        const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
        const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

        const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
          program.programId
        );
        pdaList.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agent
            user: manager.publicKey,
          })
          .remainingAccounts([
            ...pdaList.map((pda) => ({
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            })),
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      // --- Add agents ---

      // console.debug(agent_ids);
      const newServiceId = 3;
      const updated_params = [
        {
          slots: 2,
          bond: new anchor.BN(securityDeposit * 3),
        },
      ];

      // console.debug(updated_params);

      const updatedPdas = [];
      const agentBN = new anchor.BN(newServiceId);
      const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
      const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

      const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
        program.programId
      );
      updatedPdas.push(agent_param_pda);

      // console.debug(updatedPdas);

      threshold++;

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            [newServiceId],
            updated_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agent
            user: manager.publicKey,
          })
          .remainingAccounts(
            updatedPdas.map((pda) => ({
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            }))
          )
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      const updatedServiceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // console.info(
      //   'max_num_agent_instances',
      //   updatedServiceAccount.maxNumAgentInstances
      // );
      // console.info(
      //   'security_deposit',
      //   updatedServiceAccount.securityDeposit.toNumber()
      // );
      // console.info('threshold', updatedServiceAccount.threshold);

      // Check max_num_agent_instances and security_deposit
      expect(updatedServiceAccount.maxNumAgentInstances).to.equal(
        agent_ids_per_service + 2 // 2 slots for new agent
      );
      expect(updatedServiceAccount.securityDeposit.toNumber()).to.equal(3000);
      expect(updatedServiceAccount.threshold).to.equal(threshold);
    });

    it('Registers 2 agents ids, then deletes 1 via delete_agent', async function () {
      const agent_ids = [1, 2];
      const threshold = 2;
      const securityDeposit = 1000;

      const agent_params = agent_ids.map((_, i) => ({
        slots: 1,
        bond: new anchor.BN(securityDeposit * (i + 1)),
      }));

      const config_hash = new Uint8Array(32).fill(6); // Unique config for this test

      const [servicePda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('service'), config_hash.slice(0, 7)],
        program.programId
      );

      await program.methods
        .create(Array.from(config_hash), ownerService.publicKey, null)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);
      const serviceId = serviceAccount.serviceId;

      const pdaList = [];

      for (const agent_id of agent_ids) {
        const agentBN = new anchor.BN(agent_id);
        const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
        const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

        const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
          program.programId
        );
        pdaList.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      await program.methods
        .registerAgentIdsToService(
          ownerService.publicKey,
          agent_ids,
          agent_params,
          threshold
        )
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          serviceAgentIdsIndex: serviceAgentIdsIndexPDA,
          user: manager.publicKey,
        })
        .remainingAccounts(
          pdaList.map((pda) => ({
            pubkey: pda,
            isSigner: false,
            isWritable: true,
          }))
        )
        .signers([manager])
        .rpc();

      // ---- Delete agent 1 using delete_agent() ----

      const agentToDelete = 1;
      const newThreshold = 1;

      const agentBN = new anchor.BN(agentToDelete);
      const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
      const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

      const [agentToDeletePda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
        program.programId
      );

      await program.methods
        .deleteAgentIdToService(
          ownerService.publicKey,
          agentToDelete,
          newThreshold
        )
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          serviceAgentIdsIndex: serviceAgentIdsIndexPDA,
          user: manager.publicKey,
        })
        .remainingAccounts([
          {
            pubkey: agentToDeletePda,
            isSigner: false,
            isWritable: true,
          },
        ])
        .signers([manager])
        .rpc();

      const updatedServiceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      expect(updatedServiceAccount.maxNumAgentInstances).to.equal(1); // 1 agent left with 1 slot
      expect(updatedServiceAccount.threshold).to.equal(newThreshold);
    });

    it('Registers 2 agents ids, then adds a new agent using `add_agent`', async function () {
      let threshold = 1;
      const securityDeposit = 1000;
      const initialAgentId = 1;

      const initial_agent_ids = [initialAgentId];
      const initial_agent_params = [
        {
          slots: 1,
          bond: new anchor.BN(securityDeposit),
        },
      ];

      const config_hash = new Uint8Array(32).fill(7); // Unique config

      const [servicePda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('service'), config_hash.slice(0, 7)],
        program.programId
      );

      // Create service
      try {
        await program.methods
          .create(Array.from(config_hash), ownerService.publicKey, null)
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            user: manager.publicKey,
          })
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);
      const serviceId = serviceAccount.serviceId;

      const pdaList = [];

      for (const agent_id of initial_agent_ids) {
        const agentBN = new anchor.BN(agent_id);
        const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
        const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

        const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
          [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
          program.programId
        );
        pdaList.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bump] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      // Register initial agent
      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            initial_agent_ids,
            initial_agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA,
            user: manager.publicKey,
          })
          .remainingAccounts(
            pdaList.map((pda) => ({
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            }))
          )
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      // ---- Add new agent using add_agent ----
      const newAgentId = 2;
      const slots = 2;
      const bond = 2000;
      threshold = 3;

      const agentBN = new anchor.BN(newAgentId);
      const serviceIdSeed = serviceId.toArrayLike(Buffer, 'le', 16);
      const agentIdSeed = agentBN.toArrayLike(Buffer, 'le', 4);

      const [newAgentParamPDA] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('agent_param'), serviceIdSeed, agentIdSeed],
        program.programId
      );

      try {
        await program.methods
          .addAgentIdToService(
            ownerService.publicKey,
            newAgentId,
            slots,
            new anchor.BN(bond),
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA,
            user: manager.publicKey,
          })
          .remainingAccounts([
            {
              pubkey: newAgentParamPDA,
              isSigner: false,
              isWritable: true,
            },
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error(error);
      }

      const updatedServiceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      expect(updatedServiceAccount.maxNumAgentInstances).to.equal(3); // 1 from before, 2 new
      expect(updatedServiceAccount.securityDeposit.toNumber()).to.equal(bond);
      expect(updatedServiceAccount.threshold).to.equal(threshold);
    });

    it('Updates the service with new configuration', async () => {
      const agent_ids_per_service = 9;
      const threshold = 7; // 7 << threshold << 9

      // Define agent_ids and agent_params
      const agent_ids: number[] = Array.from(
        { length: agent_ids_per_service },
        (_, i) => i + 1
      );
      const agent_params = agent_ids.map((id) => ({
        slots: 1,
        bond: new anchor.BN(1000),
      }));

      const config_hash = new Uint8Array(32).fill(8);

      const [servicePda, _bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service'),
          Buffer.from(config_hash.buffer, config_hash.byteOffset, 7),
        ],
        program.programId
      );

      // Create the first service
      await program.methods
        .create(Array.from(config_hash), ownerService.publicKey, null)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      // Fetch the service account from the chain
      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // Get the actual dynamic service_id from the on-chain account
      const serviceId = serviceAccount.serviceId;

      // Add agents params
      const paramPdas = [];
      for (let i = 0; i < agent_ids.length; i++) {
        const agentId = new anchor.BN(agent_ids[i]);

        const [agent_param_pda, _bump] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from('agent_param'),
              serviceId.toArrayLike(Buffer, 'le', 16), // service_id as little-endian 16 bytes
              agentId.toArrayLike(Buffer, 'le', 4), // agent_id as little-endian 4 bytes
            ],
            program.programId
          );

        paramPdas.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      // Register agents
      await program.methods
        .registerAgentIdsToService(
          ownerService.publicKey,
          agent_ids,
          agent_params,
          threshold
        )
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          serviceAgentIdsIndex: serviceAgentIdsIndexPDA,
          user: manager.publicKey,
        })
        .remainingAccounts(
          paramPdas.map((pda) => ({
            pubkey: pda,
            isSigner: false,
            isWritable: true,
          }))
        )
        .signers([manager])
        .rpc();

      // Now let's update the service:
      const newConfigHash = new Uint8Array(32).fill(9); // new config hash
      const newThreshold = 8; // new threshold (valid value between 7 and 9)

      // Update the service
      await program.methods
        .update(
          Array.from(newConfigHash), // pass the new config hash
          ownerService.publicKey, // service owner
          newThreshold // new threshold
        )
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey, // manager updates the service
        })
        .signers([manager])
        .rpc();

      // Fetch the updated service account
      const updatedServiceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // Assert that the service was updated correctly
      assert.deepEqual(
        updatedServiceAccount.configHash,
        Array.from(newConfigHash)
      );
      assert.equal(updatedServiceAccount.threshold, newThreshold);

      // Test for threshold validation (should fail if threshold is invalid)
      const invalidThreshold = 10; // Invalid threshold (greater than max_num_agent_instances)

      try {
        await program.methods
          .update(
            Array.from(newConfigHash),
            ownerService.publicKey,
            invalidThreshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            user: manager.publicKey,
          })
          .signers([manager])
          .rpc();
        assert.fail('Transaction should have failed due to invalid threshold');
      } catch (error) {
        // Expected error for invalid threshold
        assert.equal(
          error.message,
          'AnchorError occurred. Error Code: WrongThreshold2. Error Number: 6007. Error Message: Threshold is above allowed bounds.'
        );
      }
    });

    it('Checks a service with id_service', async () => {
      let agent_ids_per_service = 9;
      const threshold = 7; // 7 << threshold << 9

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

      const config_hash = new Uint8Array(32).fill(10);

      const [servicePda, _bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service'),
          Buffer.from(config_hash.buffer, config_hash.byteOffset, 7),
        ],
        program.programId
      );

      // Create first service
      await program.methods
        .create(Array.from(config_hash), ownerService.publicKey, null)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      // console.info(servicePda);
      // console.info(ownerService.publicKey);

      // FETCH THE SERVICE ACCOUNT FROM CHAIN
      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // Get the actual dynamic service_id from the on-chain account
      const serviceId = serviceAccount.serviceId;

      //console.info(serviceId);

      // Add agents params
      const paramPdas = [];
      // Loop through agentIds to generate all the agent_param_pda addresses
      for (let i = 0; i < agent_ids.length; i++) {
        const agentId = new anchor.BN(agent_ids[i]);

        const [agent_param_pda, _bump] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from('agent_param'),
              serviceId.toArrayLike(Buffer, 'le', 16), // service_id as little-endian 16 bytes
              agentId.toArrayLike(Buffer, 'le', 4), // agent_id as little-endian 4 bytes
            ],
            program.programId
          );

        paramPdas.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      // console.debug(paramPdas);

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda, // The service account (PDA) to add agents
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agents
            user: manager.publicKey, // The manager of the registry (signer)
          })
          .remainingAccounts([
            ...paramPdas.map((pda) => ({
              // params pdas to create or update
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            })),
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error('Transaction failed:', error);
      }

      // Call check_service with the service_id
      try {
        const tx = await program.methods
          .checkService(serviceId)
          .accounts({
            service: servicePda, // The service account (PDA)
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agents
          })
          .rpc();

        // console.info('Your transaction signature', tx);

        // Récupération du compte à partir du PDA
        const serviceAccount =
          await program.account.serviceAccount.fetch(servicePda);

        // console.debug('Service Account:', serviceAccount);
        // console.debug('Service ID:', serviceAccount.serviceId);
        // console.debug('ID:', serviceId);

        assert(serviceAccount.serviceId.eq(serviceId));
      } catch (error) {
        console.error('Transaction failed:', error);
      }
    });

    it('Fetches agent params from PDAS', async () => {
      let agent_ids_per_service = 1;
      const threshold = 1;
      const bond = 1000;

      // Define agent_ids and agent_params
      const agent_ids: number[] = Array.from(
        { length: agent_ids_per_service },
        (_, i) => i + 1
      );
      const agent_params = agent_ids.map((id) => ({
        slots: 1,
        bond: new anchor.BN(bond),
      }));

      // console.info(agent_ids);
      // console.info(agent_params);

      const config_hash = new Uint8Array(32).fill(11);

      const [servicePda, _bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service'),
          Buffer.from(config_hash.buffer, config_hash.byteOffset, 7),
        ],
        program.programId
      );

      // Create first service
      await program.methods
        .create(Array.from(config_hash), ownerService.publicKey, null)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      // console.info(servicePda);
      // console.info(ownerService.publicKey);

      // FETCH THE SERVICE ACCOUNT FROM CHAIN
      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // Get the actual dynamic service_id from the on-chain account
      const serviceId = serviceAccount.serviceId;

      //console.info(serviceId);

      // Add agents params
      const paramPdas = [];
      // Loop through agentIds to generate all the agent_param_pda addresses
      for (let i = 0; i < agent_ids.length; i++) {
        const agentId = new anchor.BN(agent_ids[i]);

        const [agent_param_pda, _bump] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from('agent_param'),
              serviceId.toArrayLike(Buffer, 'le', 16), // service_id as little-endian 16 bytes
              agentId.toArrayLike(Buffer, 'le', 4), // agent_id as little-endian 4 bytes
            ],
            program.programId
          );

        paramPdas.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      //  console.debug(paramPdas);

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda, // The service account (PDA) to add agents
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agents
            user: manager.publicKey, // The manager of the registry (signer)
          })
          .remainingAccounts([
            ...paramPdas.map((pda) => ({
              // params pdas to create or update
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            })),
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error('Transaction failed:', error);
      }

      // Now, fetch the agent parameters stored in the PDAs

      for (const agentId of agent_ids) {
        const agentIdBN = new anchor.BN(agentId);
        const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('agent_param'),
            serviceId.toArrayLike(Buffer, 'le', 16),
            agentIdBN.toArrayLike(Buffer, 'le', 4),
          ],
          program.programId
        );

        // console.info(`Fetching AgentParamAccount for agentId: ${agentId}`);
        // console.info(`AgentParam PDA: ${agent_param_pda.toBase58()}`);

        try {
          const agentParamAccount =
            await program.account.agentParamAccount.fetch(agent_param_pda);
          assert.strictEqual(
            agentParamAccount.slots,
            1,
            `Slots should be 1 for agent ${agentId}`
          );
          assert.strictEqual(
            agentParamAccount.bond.toNumber(),
            1000,
            `Bond should be 1000 for agent ${agentId}`
          );
        } catch (e) {
          console.warn(
            `AgentParamAccount not found for agent_id ${agentId}:`,
            e.message
          );
        }
      }
    });

    it('Fetches agent params from index and then PDAS', async () => {
      let agent_ids_per_service = 9;
      const threshold = 7; // 7 << threshold << 9

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

      const config_hash = new Uint8Array(32).fill(12);

      const [servicePda, _bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service'),
          Buffer.from(config_hash.buffer, config_hash.byteOffset, 7),
        ],
        program.programId
      );

      // Create first service
      await program.methods
        .create(Array.from(config_hash), ownerService.publicKey, null)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      // console.info(servicePda);
      // console.info(ownerService.publicKey);

      // FETCH THE SERVICE ACCOUNT FROM CHAIN
      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // Get the actual dynamic service_id from the on-chain account
      const serviceId = serviceAccount.serviceId;

      //console.info(serviceId);

      // Add agents params
      const paramPdas = [];
      // Loop through agentIds to generate all the agent_param_pda addresses
      for (let i = 0; i < agent_ids.length; i++) {
        const agentId = new anchor.BN(agent_ids[i]);

        const [agent_param_pda, _bump] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from('agent_param'),
              serviceId.toArrayLike(Buffer, 'le', 16), // service_id as little-endian 16 bytes
              agentId.toArrayLike(Buffer, 'le', 4), // agent_id as little-endian 4 bytes
            ],
            program.programId
          );

        paramPdas.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      // console.debug(paramPdas);

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda, // The service account (PDA) to add agents
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agents
            user: manager.publicKey, // The manager of the registry (signer)
          })
          .remainingAccounts([
            ...paramPdas.map((pda) => ({
              // params pdas to create or update
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            })),
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error('Transaction failed:', error);
      }

      // Fetch from PDAS indexes then params for each

      // Fetch the serviceAgentIdsIndex account
      const serviceAgentIdsIndex =
        await program.account.serviceAgentIdsIndex.fetch(
          serviceAgentIdsIndexPDA
        );

      // This gives you the array of agent_ids and their params stored on-chain
      const agentParamsOnChain = [];

      // console.debug(serviceAgentIdsIndex.agentIds);

      for (const param of serviceAgentIdsIndex.agentIds) {
        const agentId = new anchor.BN(param.agentId);

        const [agent_param_pda] = anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('agent_param'),
            serviceId.toArrayLike(Buffer, 'le', 16),
            agentId.toArrayLike(Buffer, 'le', 4),
          ],
          program.programId
        );

        try {
          const agentParamAccount =
            await program.account.agentParamAccount.fetch(agent_param_pda);

          // console.info(`Agent ID ${agentId.toNumber()}:`);
          // console.debug(agentParamAccount);
          // console.info(`Slots: ${agentParamAccount.slots}`);
          // console.info(`Bond: ${agentParamAccount.bond.toNumber()}`);

          // Convertir bond en number
          const transformedAgentParam = {
            serviceAgentIdsIndex: agentId.toNumber(),
            slots: agentParamAccount.slots,
            bond: agentParamAccount.bond.toNumber(), // convert bond from BN to number
          };

          agentParamsOnChain.push(transformedAgentParam);
        } catch (e) {
          console.warn(
            `AgentParamAccount not found for agent_id ${agentId.toString()}`
          );
        }
      }
      //  console.info(agentParamsOnChain);
    });

    it('Activates a service', async () => {
      let agent_ids_per_service = 1;
      const threshold = 1;
      const bond = 1 * anchor.web3.LAMPORTS_PER_SOL;

      // Define agent_ids and agent_params
      const agent_ids: number[] = Array.from(
        { length: agent_ids_per_service },
        (_, i) => i + 1
      );
      const agent_params = agent_ids.map((id) => ({
        slots: 1,
        bond: new anchor.BN(bond),
      }));

      // console.info(agent_ids);
      // console.info(agent_params);

      const config_hash = new Uint8Array(32).fill(13);

      const [servicePda, _bump] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service'),
          Buffer.from(config_hash.buffer, config_hash.byteOffset, 7),
        ],
        program.programId
      );

      // Create first service
      await program.methods
        .create(Array.from(config_hash), ownerService.publicKey, null)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey,
        })
        .signers([manager])
        .rpc();

      // console.info(servicePda);
      // console.info(ownerService.publicKey);

      // FETCH THE SERVICE ACCOUNT FROM CHAIN
      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);

      // Get the actual dynamic service_id from the on-chain account
      const serviceId = serviceAccount.serviceId;

      // console.info(serviceId);

      // Add agents params
      const paramPdas = [];
      // Loop through agentIds to generate all the agent_param_pda addresses
      for (let i = 0; i < agent_ids.length; i++) {
        const agentId = new anchor.BN(agent_ids[i]);

        const [agent_param_pda, _bump] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from('agent_param'),
              serviceId.toArrayLike(Buffer, 'le', 16), // service_id as little-endian 16 bytes
              agentId.toArrayLike(Buffer, 'le', 4), // agent_id as little-endian 4 bytes
            ],
            program.programId
          );

        paramPdas.push(agent_param_pda);
      }

      const [serviceAgentIdsIndexPDA, _bumpServiceAgentIdsIndex] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_ids_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
          ],
          program.programId
        );

      //  console.debug(paramPdas);

      try {
        await program.methods
          .registerAgentIdsToService(
            ownerService.publicKey,
            agent_ids,
            agent_params,
            threshold
          )
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda, // The service account (PDA) to add agents
            serviceAgentIdsIndex: serviceAgentIdsIndexPDA, // The vector registry account to index agents
            user: manager.publicKey, // The manager of the registry (signer)
          })
          .remainingAccounts([
            ...paramPdas.map((pda) => ({
              // params pdas to create or update
              pubkey: pda,
              isSigner: false,
              isWritable: true,
            })),
          ])
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error('Transaction failed:', error);
      }

      const serviceAccountBefore =
        await program.account.serviceAccount.fetch(servicePda);
      expect(serviceAccountBefore.state.activeRegistration).to.be.undefined;

      const [programWalletPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [Buffer.from('registry_wallet'), registryAccount.publicKey.toBuffer()],
        program.programId
      );

      try {
        await program.methods
          .activateRegistration(ownerService.publicKey, serviceId)
          .accounts({
            registry: registryAccount.publicKey,
            service: servicePda,
            user: manager.publicKey,
            registryWallet: programWalletPda,
          })
          .signers([manager])
          .rpc();
      } catch (error) {
        console.error('Transaction failed:', error);
      }

      const updatedService =
        await program.account.serviceAccount.fetch(servicePda);

      expect(updatedService.state.preRegistration).to.be.undefined;
      expect(updatedService.state.activeRegistration).not.to.be.undefined;
    });

    it('Registers one agent instance in a service', async () => {
      const agent_ids_per_service = 1;
      const threshold = 1;
      const agentsToRegister = 1;
      const config_hash = new Uint8Array(32).fill(15);

      const {
        serviceId,
        servicePda,
        agentInstances,
        operator,
        instancesBond,
        operatorBondPda,
      } = await registerMultipleAgentInstances(
        registryAccount,
        config_hash,
        agent_ids_per_service,
        threshold,
        agentsToRegister
      );

      expect(servicePda).to.be.instanceOf(anchor.web3.PublicKey);
      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);
      expect(serviceAccount).to.not.be.null;

      expect(agentInstances.length).to.equal(agentsToRegister);

      // Check operator bond increased
      const bond = agentsToRegister * anchor.web3.LAMPORTS_PER_SOL;
      const operatorBond =
        await program.account.operatorBondAccount.fetch(operatorBondPda);
      expect(operatorBond.operator.equals(operator.publicKey)).to.be.true;
      expect(operatorBond.serviceId.toString()).to.equal(serviceId.toString());
      expect(operatorBond.bond.toNumber()).to.equal(instancesBond.toNumber());
      expect(operatorBond.bond.toNumber()).to.equal(bond);
    });

    it('Registers multiple agent instances in a service and check operator bond', async () => {
      const agent_ids_per_service = 9;
      const threshold = 7;
      const agentsToRegister = 3;
      const config_hash = new Uint8Array(32).fill(16);

      const { instancesBond, operatorBondPda } =
        await registerMultipleAgentInstances(
          registryAccount,
          config_hash,
          agent_ids_per_service,
          threshold,
          agentsToRegister
        );

      const operatorBond =
        await program.account.operatorBondAccount.fetch(operatorBondPda);
      expect(operatorBond.bond.toNumber()).to.equal(instancesBond.toNumber());
    });

    it('Terminates a service', async () => {
      const agent_ids_per_service = 1;
      const threshold = 1;
      const agentsToRegister = 1;
      const config_hash = new Uint8Array(32).fill(17);

      const { serviceId, servicePda, agentInstances, programWalletPda } =
        await registerMultipleAgentInstances(
          registryAccount,
          config_hash,
          agent_ids_per_service,
          threshold,
          agentsToRegister
        );

      const serviceOwnerBalanceBefore = await provider.connection.getBalance(
        ownerService.publicKey
      );

      const { serviceAgentIdsIndexPDA } = await terminateService({
        program,
        registryAccount,
        serviceId,
        servicePda,
        agent_ids_per_service,
        agentInstances,
        ownerService,
        manager,
        programWalletPda,
      });

      const serviceAfter =
        await program.account.serviceAccount.fetch(servicePda);
      assert.ok(
        serviceAfter.state.preRegistration !== undefined ||
          serviceAfter.state.terminatedBonded !== undefined,
        'Service state should have transitioned to a terminated state'
      );

      const serviceOwnerBalanceAfter = await provider.connection.getBalance(
        ownerService.publicKey
      );

      assert.ok(serviceOwnerBalanceAfter > serviceOwnerBalanceBefore);

      try {
        await program.account.serviceAgentIdsIndex.fetch(
          serviceAgentIdsIndexPDA
        );
        assert.fail('serviceAgentIdsIndex account should be closed');
      } catch (err) {
        assert.ok('Account closed as expected');
      }
    });

    it('Unbonds a service', async () => {
      const agent_ids_per_service = 1;
      const threshold = 1;
      const agentsToRegister = 1;
      const config_hash = new Uint8Array(32).fill(18);

      const {
        serviceId,
        servicePda,
        agentInstances,
        operator,
        instancesBond,
        programWalletPda,
        operatorBondPda,
      } = await registerMultipleAgentInstances(
        registryAccount,
        config_hash,
        agent_ids_per_service,
        threshold,
        agentsToRegister
      );

      await terminateService({
        program,
        registryAccount,
        serviceId,
        servicePda,
        agent_ids_per_service,
        agentInstances,
        ownerService,
        manager,
        programWalletPda,
      });

      const [operatorAgentInstanceIndexPda] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('operator_agent_instance_index'),
            serviceId.toArrayLike(Buffer, 'le', 16),
            operator.publicKey.toBuffer(),
          ],
          program.programId
        );

      const operatorBondBefore =
        await program.account.operatorBondAccount.fetch(operatorBondPda);
      expect(operatorBondBefore.bond.toNumber()).to.equal(
        instancesBond.toNumber()
      );

      const operatorBalanceBefore = await provider.connection.getBalance(
        operator.publicKey
      );
      expect(operatorBalanceBefore).to.be.greaterThan(0);

      //console.debug(operatorBalanceBefore);

      const operatorAgentInstanceIndexAccount =
        await program.account.operatorAgentInstanceIndex.fetch(
          operatorAgentInstanceIndexPda
        );

      const remainingAccounts = [];

      for (const operatorAgentInstancePda of operatorAgentInstanceIndexAccount.operatorAgentInstances) {
        try {
          const operatorAgentInstance =
            await program.account.operatorAgentInstanceAccount.fetch(
              operatorAgentInstancePda
            );
          if (operatorAgentInstance.operator.equals(operator.publicKey)) {
            remainingAccounts.push({
              pubkey: operatorAgentInstancePda,
              isWritable: true,
              isSigner: false,
            });
          }
        } catch (e) {
          console.warn(
            'Invalid PDA in index:',
            operatorAgentInstancePda.toBase58(),
            e
          );
        }
      }

      assert.equal(remainingAccounts.length, agentInstances.length);

      await program.methods
        .unbond(serviceId)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          operator: operator.publicKey,
          operatorBond: operatorBondPda,
          operatorAgentInstanceIndex: operatorAgentInstanceIndexPda,
          user: manager.publicKey,
          registryWallet: programWalletPda,
        })
        .remainingAccounts(remainingAccounts)
        .signers([manager, operator])
        .rpc();

      // Operator bond must be wiped
      let deletedAccount =
        await provider.connection.getAccountInfo(operatorBondPda);
      expect(deletedAccount).to.be.null;

      // Operator's lamport balance must have increased
      const operatorBalance = await provider.connection.getBalance(
        operator.publicKey
      );
      expect(operatorBalance).to.be.greaterThan(operatorBalanceBefore);

      //console.debug(operatorBalance);

      // Service must be in PreRegistration state again
      const serviceAccount =
        await program.account.serviceAccount.fetch(servicePda);
      expect(serviceAccount.state.terminatedBonded).to.be.undefined;
      expect(serviceAccount.state.preRegistration).to.not.be.undefined;

      // OperatorAgentInstanceIndex should be wiped
      deletedAccount = await provider.connection.getAccountInfo(
        operatorAgentInstanceIndexPda
      );
      expect(deletedAccount).to.be.null;
    });
  });

  describe('Registry Drainer Tests', () => {
    let registryAccount: anchor.web3.Keypair;
    let owner: anchor.web3.Keypair;
    let drainer: anchor.web3.PublicKey;
    let connection: anchor.web3.Connection;

    before(async function () {
      registryAccount = anchor.web3.Keypair.generate();
      owner = anchor.web3.Keypair.generate();
      drainer = anchor.web3.Keypair.generate().publicKey;
      connection = anchor.getProvider().connection;

      // Airdrop to user (the current owner)
      let airdropSignature = await connection.requestAirdrop(
        owner.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSignature);

      // Initialize the registry (assuming the registry initialization is similar to previous tests)
      await program.methods
        .initialize(name, symbol, base_uri, manager.publicKey, drainer)
        .accounts({
          registry: registryAccount.publicKey,
          user: owner.publicKey,
        })
        .signers([owner, registryAccount])
        .rpc();
    });

    it('Changes the drainer of the registry', async function () {
      const anotherDrainer = anchor.web3.Keypair.generate().publicKey;
      try {
        await program.methods
          .changeDrainer(anotherDrainer)
          .accounts({
            registry: registryAccount.publicKey,
            user: owner.publicKey,
          })
          .signers([owner])
          .rpc();
      } catch (error) {
        console.error('Transaction failed:', error);
      }

      // Fetch the updated registry account
      const registry = await program.account.serviceRegistry.fetch(
        registryAccount.publicKey
      );

      // Check that the drainer has been updated correctly
      expect(registry.drainer.toBase58()).to.equal(anotherDrainer.toBase58());
    });
  });

  async function registerMultipleAgentInstances(
    registryAccount: anchor.web3.Keypair,
    config_hash: Uint8Array<ArrayBuffer>,
    agent_ids_per_service: number,
    threshold: number,
    agentsToRegister: number
  ) {
    const agent_ids: number[] = Array.from(
      { length: agent_ids_per_service },
      (_, i) => i + 1
    );
    const agent_params = agent_ids.map((_value, index) => ({
      slots: 1,
      bond: new anchor.BN(anchor.web3.LAMPORTS_PER_SOL * (index + 1)),
    }));

    const { servicePda, serviceId } = await createService(
      registryAccount,
      config_hash
    );

    const paramPdas = await registerAgentIdsToService(
      registryAccount,
      servicePda,
      serviceId,
      agent_ids,
      agent_params,
      threshold
    );

    const programWalletPda = await activateServiceRegistration(
      registryAccount,
      servicePda,
      serviceId
    );

    const { agentInstances, operator, instancesBond, operatorBondPda } =
      await registerAgentInstances(
        registryAccount,
        servicePda,
        serviceId,
        agent_ids,
        paramPdas.slice(0, agentsToRegister),
        agentsToRegister,
        programWalletPda
      );

    return {
      serviceId,
      servicePda,
      agentInstances,
      operator,
      instancesBond,
      programWalletPda,
      operatorBondPda,
    };
  }

  async function createService(
    registryAccount: anchor.web3.Keypair,
    config_hash: Uint8Array<ArrayBuffer>
  ) {
    const [servicePda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from('service'),
        Buffer.from(config_hash.buffer, config_hash.byteOffset, 7),
      ],
      program.programId
    );

    await program.methods
      .create(Array.from(config_hash), ownerService.publicKey, null)
      .accounts({
        registry: registryAccount.publicKey,
        service: servicePda,
        user: manager.publicKey,
      })
      .signers([manager])
      .rpc();

    const serviceAccount =
      await program.account.serviceAccount.fetch(servicePda);
    return { servicePda, serviceId: serviceAccount.serviceId };
  }

  async function registerAgentIdsToService(
    registryAccount: anchor.web3.Keypair,
    servicePda: anchor.web3.PublicKey,
    serviceId: anchor.BN,
    agent_ids: number[],
    agent_params: { slots: number; bond: anchor.BN }[],
    threshold: number
  ) {
    const [serviceAgentIdsIndexPDA] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service_agent_ids_index'),
          serviceId.toArrayLike(Buffer, 'le', 16),
        ],
        program.programId
      );

    const paramPdas = agent_ids.map((id) => {
      const agentId = new anchor.BN(id);
      const [pda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('agent_param'),
          serviceId.toArrayLike(Buffer, 'le', 16),
          agentId.toArrayLike(Buffer, 'le', 4),
        ],
        program.programId
      );
      return pda;
    });

    await program.methods
      .registerAgentIdsToService(
        ownerService.publicKey,
        agent_ids,
        agent_params,
        threshold
      )
      .accounts({
        registry: registryAccount.publicKey,
        service: servicePda,
        serviceAgentIdsIndex: serviceAgentIdsIndexPDA,
        user: manager.publicKey,
      })
      .remainingAccounts(
        paramPdas.map((pda) => ({
          pubkey: pda,
          isSigner: false,
          isWritable: true,
        }))
      )
      .signers([manager])
      .rpc();

    return paramPdas;
  }

  async function activateServiceRegistration(
    registryAccount: anchor.web3.Keypair,
    servicePda: anchor.web3.PublicKey,
    serviceId: anchor.BN
  ) {
    const [programWalletPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('registry_wallet'), registryAccount.publicKey.toBuffer()],
      program.programId
    );

    try {
      await program.methods
        .activateRegistration(ownerService.publicKey, serviceId)
        .accounts({
          registry: registryAccount.publicKey,
          service: servicePda,
          user: manager.publicKey,
          registryWallet: programWalletPda,
        })
        .signers([manager])
        .rpc();
    } catch (error) {
      console.error('Transaction failed:', error);
    }

    return programWalletPda;
  }

  async function registerAgentInstances(
    registryAccount: anchor.web3.Keypair,
    servicePda: anchor.web3.PublicKey,
    serviceId: anchor.BN,
    agent_ids: number[],
    paramPdas: anchor.web3.PublicKey[],
    agentsToRegister: number,
    programWalletPda: anchor.web3.PublicKey
  ) {
    const agentInstances: anchor.web3.Keypair[] = [];
    const agentInstancePubkeys: anchor.web3.PublicKey[] = [];
    const operator = anchor.web3.Keypair.generate();

    const instancesBond = Array.from(
      { length: agentsToRegister },
      (_, i) => new anchor.BN(anchor.web3.LAMPORTS_PER_SOL * (i + 1))
    ).reduce((acc, bond) => acc.add(bond), new anchor.BN(0));

    const airdropSignature = await connection.requestAirdrop(
      operator.publicKey,
      instancesBond.toNumber()
    );
    await connection.confirmTransaction(airdropSignature);

    const [operatorAsAgentPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [Buffer.from('agent_instances_index'), operator.publicKey.toBuffer()],
      program.programId
    );

    const pdaList = [...paramPdas, operatorAsAgentPda];

    for (let i = 0; i < agentsToRegister; i++) {
      const agentId = new anchor.BN(agent_ids[i]);
      const agentInstance = anchor.web3.Keypair.generate();
      agentInstances.push(agentInstance);
      agentInstancePubkeys.push(agentInstance.publicKey);

      const [agentInstancesPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('agent_instances_index'),
          serviceId.toArrayLike(Buffer, 'le', 16),
          agentId.toArrayLike(Buffer, 'le', 4),
        ],
        program.programId
      );

      const [slotCounterPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service_agent_slot'),
          serviceId.toArrayLike(Buffer, 'le', 16),
          agentId.toArrayLike(Buffer, 'le', 4),
        ],
        program.programId
      );

      const [serviceAgentInstancePda] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('service_agent_instance_account'),
            serviceId.toArrayLike(Buffer, 'le', 16),
            agentId.toArrayLike(Buffer, 'le', 4),
            agentInstance.publicKey.toBuffer(),
          ],
          program.programId
        );

      const [operatorAgentInstancePda] =
        anchor.web3.PublicKey.findProgramAddressSync(
          [
            Buffer.from('operator_agent_instance'),
            agentInstance.publicKey.toBuffer(),
            operator.publicKey.toBuffer(),
          ],
          program.programId
        );

      pdaList.push(
        agentInstancesPda,
        slotCounterPda,
        serviceAgentInstancePda,
        operatorAgentInstancePda
      );
    }

    const [operatorBondPda] = anchor.web3.PublicKey.findProgramAddressSync(
      [
        Buffer.from('operator_bond'),
        serviceId.toArrayLike(Buffer, 'le', 16),
        operator.publicKey.toBuffer(),
      ],
      program.programId
    );
    pdaList.push(operatorBondPda);

    const [operatorAgentInstanceIndexPda] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('operator_agent_instance_index'),
          serviceId.toArrayLike(Buffer, 'le', 16),
          operator.publicKey.toBuffer(),
        ],
        program.programId
      );

    await program.methods
      .registerAgents(
        operator.publicKey,
        agentInstancePubkeys,
        agent_ids.slice(0, agentsToRegister)
      )
      .accounts({
        registry: registryAccount.publicKey,
        service: servicePda,
        user: manager.publicKey,
        registryWallet: programWalletPda,
        operatorAgentInstanceIndex: operatorAgentInstanceIndexPda,
      })
      .remainingAccounts(
        pdaList.map((pda, idx) => ({
          pubkey: pda,
          isSigner: false,
          isWritable: idx >= paramPdas.length,
        }))
      )
      .signers([manager])
      .rpc();

    return { agentInstances, operator, instancesBond, operatorBondPda };
  }

  async function terminateService({
    program,
    registryAccount,
    serviceId,
    servicePda,
    agent_ids_per_service,
    agentInstances,
    ownerService,
    manager,
    programWalletPda,
  }: {
    program: any;
    registryAccount: any;
    serviceId: anchor.BN;
    servicePda: anchor.web3.PublicKey;
    agent_ids_per_service: number;
    agentInstances: anchor.web3.Keypair[];
    ownerService: anchor.web3.Keypair;
    manager: anchor.web3.Keypair;
    programWalletPda: anchor.web3.PublicKey;
  }) {
    const [serviceAgentIdsIndexPDA] =
      anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service_agent_ids_index'),
          serviceId.toArrayLike(Buffer, 'le', 16),
        ],
        program.programId
      );

    const agent_ids: number[] = Array.from(
      { length: agent_ids_per_service },
      (_, i) => i + 1
    );

    const slotCounterAccounts = [];
    const serviceAgentInstanceIndexAccounts = [];
    const serviceAgentInstancePDAs = [];

    for (const agent_id of agent_ids) {
      const agentId = new anchor.BN(agent_id);
      const [slotCounterPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('service_agent_slot'),
          serviceId.toArrayLike(Buffer, 'le', 16),
          agentId.toArrayLike(Buffer, 'le', 4),
        ],
        program.programId
      );
      slotCounterAccounts.push({
        pubkey: slotCounterPda,
        isSigner: false,
        isWritable: true,
      });

      const [agentInstancesPda] = anchor.web3.PublicKey.findProgramAddressSync(
        [
          Buffer.from('agent_instances_index'),
          serviceId.toArrayLike(Buffer, 'le', 16),
          agentId.toArrayLike(Buffer, 'le', 4),
        ],
        program.programId
      );
      serviceAgentInstanceIndexAccounts.push({
        pubkey: agentInstancesPda,
        isSigner: false,
        isWritable: true,
      });

      const serviceAgentInstancesIndex =
        await program.account.serviceAgentInstancesIndex.fetch(
          agentInstancesPda
        );

      assert.equal(
        agentInstances.map((k) => k.publicKey).length,
        serviceAgentInstancesIndex.serviceAgentInstances.length
      );

      for (const agentInstance of serviceAgentInstancesIndex.serviceAgentInstances) {
        const [serviceAgentInstancePda] =
          anchor.web3.PublicKey.findProgramAddressSync(
            [
              Buffer.from('service_agent_instance_account'),
              serviceId.toArrayLike(Buffer, 'le', 16),
              agentId.toArrayLike(Buffer, 'le', 4),
              agentInstance.toBuffer(),
            ],
            program.programId
          );
        serviceAgentInstancePDAs.push({
          pubkey: serviceAgentInstancePda,
          isSigner: false,
          isWritable: true,
        });
      }
    }

    await program.methods
      .terminate(new anchor.BN(serviceId))
      .accounts({
        registry: registryAccount.publicKey,
        service: servicePda,
        serviceOwner: ownerService.publicKey,
        serviceAgentIdsIndex: serviceAgentIdsIndexPDA,
        user: manager.publicKey,
        registryWallet: programWalletPda,
      })
      .remainingAccounts([
        ...slotCounterAccounts,
        ...serviceAgentInstanceIndexAccounts,
        ...serviceAgentInstancePDAs,
      ])
      .signers([manager, ownerService])
      .rpc();

    return {
      serviceAgentIdsIndexPDA,
    };
  }
});
