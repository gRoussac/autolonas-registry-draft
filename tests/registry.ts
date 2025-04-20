import * as anchor from '@coral-xyz/anchor';
import { BN, Program } from '@coral-xyz/anchor';
import { Registry } from '../target/types/registry';
import { assert, expect } from 'chai';

describe('registry', () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.registry as Program<Registry>;
  const name = 'test_token';
  const symbol = 'AUTO';
  const base_uri = 'base_uri';

  const ownerRegistry = anchor.web3.Keypair.generate();
  const manager = anchor.web3.Keypair.generate();
  const drainer = anchor.web3.Keypair.generate().publicKey;

  it('Initializes Registry', async () => {
    const registryAccount = anchor.web3.Keypair.generate();

    // Airdrop SOL to owner
    const connection = anchor.getProvider().connection;
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
  });

  describe('Service Registry Tests', () => {
    let ownerRegistry: anchor.web3.Keypair;
    let ownerService: anchor.web3.Keypair;
    let registryAccount: anchor.web3.Keypair;
    let connection: anchor.web3.Connection;

    before(async function () {
      registryAccount = anchor.web3.Keypair.generate();
      ownerService = anchor.web3.Keypair.generate();
      ownerRegistry = anchor.web3.Keypair.generate();
      connection = anchor.getProvider().connection;

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
        20 * anchor.web3.LAMPORTS_PER_SOL
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

      // console.info(paramPdas);

      try {
        await program.methods
          .registerAgents(
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

    it('Registers 9 agents, then removes 8 of them', async function () {
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
          .registerAgents(
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
          .registerAgents(
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

    it('Registers 3 agents, then removes 1 of them', async function () {
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
          .registerAgents(
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
          .registerAgents(
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

    it('Registers 2 agents, then adds 1 of them', async function () {
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
          .registerAgents(
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
          .registerAgents(
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

    it('Registers 2 agents, then deletes 1 via delete_agent', async function () {
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
        .registerAgents(
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
        .deleteAgent(ownerService.publicKey, agentToDelete, newThreshold)
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

    it('Registers 2 agents, then adds a new agent using `add_agent`', async function () {
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
          .registerAgents(
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
          .addAgent(
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
        .registerAgents(
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
  });

  describe('Registry Ownership and Drainer Tests', () => {
    let registryAccount: anchor.web3.Keypair;
    let user: anchor.web3.Keypair;
    let newOwner: anchor.web3.PublicKey;
    let newDrainer: anchor.web3.PublicKey;
    let connection: anchor.web3.Connection;

    beforeEach(async function () {
      registryAccount = anchor.web3.Keypair.generate();
      user = anchor.web3.Keypair.generate();
      newOwner = anchor.web3.Keypair.generate().publicKey;
      newDrainer = anchor.web3.Keypair.generate().publicKey;
      connection = anchor.getProvider().connection;

      // Airdrop to user (the current owner)
      let airdropSignature = await connection.requestAirdrop(
        user.publicKey,
        2 * anchor.web3.LAMPORTS_PER_SOL
      );
      await connection.confirmTransaction(airdropSignature);

      // Initialize the registry (assuming the registry initialization is similar to previous tests)
      await program.methods
        .initialize(name, symbol, base_uri, user.publicKey, newDrainer)
        .accounts({
          registry: registryAccount.publicKey,
          user: user.publicKey,
        })
        .signers([user, registryAccount])
        .rpc();
    });

    it('Changes the owner of the registry', async function () {
      // Change the owner using the change_owner function
      await program.methods
        .changeOwner(newOwner)
        .accounts({
          registry: registryAccount.publicKey,
          user: user.publicKey,
        })
        .signers([user])
        .rpc();

      // Fetch the updated registry account
      const registry = await program.account.serviceRegistry.fetch(
        registryAccount.publicKey
      );

      // Check that the owner has been updated correctly
      expect(registry.owner.toBase58()).to.equal(newOwner.toBase58());
    });

    it('Changes the drainer of the registry', async function () {
      // Change the drainer using the change_drainer function
      const anotherDrainer = anchor.web3.Keypair.generate().publicKey;
      await program.methods
        .changeDrainer(anotherDrainer)
        .accounts({
          registry: registryAccount.publicKey,
          user: user.publicKey,
        })
        .signers([user])
        .rpc();

      // Fetch the updated registry account
      const registry = await program.account.serviceRegistry.fetch(
        registryAccount.publicKey
      );

      // Check that the drainer has been updated correctly
      expect(registry.drainer.toBase58()).to.equal(anotherDrainer.toBase58());
    });
  });
});
