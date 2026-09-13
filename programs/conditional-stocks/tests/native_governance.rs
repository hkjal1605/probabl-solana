//! Host-processor coverage complements (never replaces) the actual SBF validator tests.
#![allow(deprecated)] // Agave 3.1's pinned test API is used only by this harness.
use anchor_lang::solana_program::instruction::Instruction;
use anchor_lang::{AccountDeserialize, AccountSerialize, InstructionData, ToAccountMetas};
use conditional_stocks::{
    accounts, instruction,
    state::{Config, Roles, ADMIN_DELAY},
    ID,
};
use solana_program_test::{processor, ProgramTest, ProgramTestContext};
use solana_sdk::{
    account::Account,
    pubkey::Pubkey,
    signature::{Keypair, Signer},
    transaction::Transaction,
};

// Anchor ties every entrypoint borrow to AccountInfo's inner lifetime, whereas
// ProgramTest accepts independent borrows. This adapter is confined to tests:
// the synchronous invocation cannot retain any account reference after return.
fn host_entry<'a>(
    program: &Pubkey,
    accounts: &[anchor_lang::prelude::AccountInfo<'a>],
    data: &[u8],
) -> anchor_lang::solana_program::entrypoint::ProgramResult {
    unsafe {
        conditional_stocks::entry(
            std::mem::transmute::<&Pubkey, &'a Pubkey>(program),
            std::mem::transmute::<
                &[anchor_lang::prelude::AccountInfo<'a>],
                &'a [anchor_lang::prelude::AccountInfo<'a>],
            >(accounts),
            std::mem::transmute::<&[u8], &'a [u8]>(data),
        )
    }
}

async fn send_instruction(
    context: &mut ProgramTestContext,
    signer: &Keypair,
    ix: Instruction,
    succeeds: bool,
) {
    let hash = context.get_new_latest_blockhash().await.unwrap();
    let tx = Transaction::new_signed_with_payer(&[ix], Some(&signer.pubkey()), &[signer], hash);
    let result = context.banks_client.process_transaction(tx).await;
    assert_eq!(
        result.is_ok(),
        succeeds,
        "unexpected transaction result: {result:?}"
    );
}

#[tokio::test]
async fn lifecycle_cutoff_commitment_and_separated_roles() {
    use conditional_stocks::{
        governance::resolution_hash,
        state::{Market, Terms},
    };
    let admin = Keypair::new();
    let operator = Keypair::new();
    let guardian = Keypair::new();
    let resolver = Keypair::new();
    let outsider = Keypair::new();
    let (config, bump) = Pubkey::find_program_address(&[b"config", admin.pubkey().as_ref()], &ID);
    let id = [1u8; 32];
    let (market, market_bump) =
        Pubkey::find_program_address(&[b"market", config.as_ref(), &id], &ID);
    let mut program = ProgramTest::new("conditional_stocks", ID, processor!(host_entry));
    program.prefer_bpf(false);
    for signer in [&admin, &operator, &guardian, &resolver, &outsider] {
        program.add_account(
            signer.pubkey(),
            Account {
                lamports: 1_000_000_000,
                ..Account::default()
            },
        );
    }
    let mut config_data = Vec::new();
    Config {
        seed_authority: admin.pubkey(),
        admin: admin.pubkey(),
        quote_mint: Pubkey::new_unique(),
        roles: Roles {
            market_admin: operator.pubkey(),
            guardian: guardian.pubkey(),
            resolution_admin: resolver.pubkey(),
        },
        paused: false,
        maker_bps: 0,
        taker_bps: 0,
        pending_admin: Pubkey::default(),
        admin_after: 0,
        bump,
    }
    .try_serialize(&mut config_data)
    .unwrap();
    program.add_account(
        config,
        Account {
            lamports: 10_000_000,
            data: config_data,
            owner: ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let terms = Terms {
        condition: [2; 32],
        yes_index: 1,
        no_index: 2,
        rules_hash: [3; 32],
        metadata_hash: [4; 32],
        metadata_uri: "ipfs://mock".into(),
        trading_open: 100,
        trading_cutoff: 200,
        tick: protocol_core::WAD,
        step: 1,
        min_notional: 1,
        max_quantity: 100,
        max_order: 100,
        max_wallet: 200,
        max_market: 400,
    };
    let mut market_data = Vec::new();
    Market {
        config,
        id,
        terms,
        mints: [Pubkey::default(); 6],
        decimals: [6, 6],
        vaults_initialized: 63,
        state: protocol_core::SCHEDULED,
        sequence: [0; 2],
        open_notional: 0,
        credits: [0; 6],
        escrow: [0; 6],
        backing: [0; 2],
        fees: [0; 4],
        resolution_commitment: [0; 32],
        payouts: [0; 2],
        evidence: [0; 32],
        evidence_uri: String::new(),
        resolved_at: 0,
        bump: market_bump,
    }
    .try_serialize(&mut market_data)
    .unwrap();
    // Account capacity must match init allocation when evidence URI grows.
    market_data.resize(8 + <Market as anchor_lang::Space>::INIT_SPACE, 0);
    program.add_account(
        market,
        Account {
            lamports: 100_000_000,
            data: market_data,
            owner: ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    let mut context = program.start_with_context().await;
    let mut clock: anchor_lang::prelude::Clock = context.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp = 99;
    context.set_sysvar(&clock);
    let lifecycle = |actor: Pubkey, action: u8, commitment: [u8; 32]| Instruction {
        program_id: ID,
        accounts: accounts::Lifecycle {
            actor,
            config,
            market,
        }
        .to_account_metas(None),
        data: instruction::Lifecycle { action, commitment }.data(),
    };
    send_instruction(
        &mut context,
        &operator,
        lifecycle(operator.pubkey(), 0, [0; 32]),
        false,
    )
    .await;
    clock.unix_timestamp = 100;
    context.set_sysvar(&clock);
    send_instruction(
        &mut context,
        &outsider,
        lifecycle(outsider.pubkey(), 0, [0; 32]),
        false,
    )
    .await;
    send_instruction(
        &mut context,
        &operator,
        lifecycle(operator.pubkey(), 0, [0; 32]),
        true,
    )
    .await;
    send_instruction(
        &mut context,
        &operator,
        lifecycle(operator.pubkey(), 0, [0; 32]),
        false,
    )
    .await;
    send_instruction(
        &mut context,
        &guardian,
        lifecycle(guardian.pubkey(), 1, [0; 32]),
        false,
    )
    .await;
    clock.unix_timestamp = 199;
    context.set_sysvar(&clock);
    send_instruction(
        &mut context,
        &outsider,
        lifecycle(outsider.pubkey(), 2, [0; 32]),
        false,
    )
    .await;
    clock.unix_timestamp = 200;
    context.set_sysvar(&clock);
    send_instruction(
        &mut context,
        &outsider,
        lifecycle(outsider.pubkey(), 2, [0; 32]),
        true,
    )
    .await;
    let evidence = [8; 32];
    let uri = "ipfs://approved";
    let commitment = resolution_hash(&config, &market, 1, 1, &evidence, uri);
    send_instruction(
        &mut context,
        &resolver,
        lifecycle(resolver.pubkey(), 3, commitment),
        false,
    )
    .await;
    send_instruction(
        &mut context,
        &operator,
        lifecycle(operator.pubkey(), 3, [0; 32]),
        false,
    )
    .await;
    send_instruction(
        &mut context,
        &operator,
        lifecycle(operator.pubkey(), 3, commitment),
        true,
    )
    .await;
    let resolve = |actor: Pubkey, yes: u8, no: u8, evidence: [u8; 32], uri: String| Instruction {
        program_id: ID,
        accounts: accounts::Lifecycle {
            actor,
            config,
            market,
        }
        .to_account_metas(None),
        data: instruction::Resolve {
            yes,
            no,
            evidence,
            uri,
        }
        .data(),
    };
    let pending = context
        .banks_client
        .get_account(market)
        .await
        .unwrap()
        .unwrap()
        .data;
    for (actor, yes, no, proof, location) in [
        (&operator, 1, 1, evidence, uri.to_string()),
        (&resolver, 0, 0, evidence, uri.to_string()),
        (&resolver, 1, 0, evidence, uri.to_string()),
        (&resolver, 1, 1, [9; 32], uri.to_string()),
        (&resolver, 1, 1, evidence, format!("{uri}/")),
        (&resolver, 1, 1, [0; 32], uri.to_string()),
        (&resolver, 1, 1, evidence, String::new()),
        (&resolver, 1, 1, evidence, "x".repeat(513)),
    ] {
        send_instruction(
            &mut context,
            actor,
            resolve(actor.pubkey(), yes, no, proof, location),
            false,
        )
        .await;
        assert_eq!(
            context
                .banks_client
                .get_account(market)
                .await
                .unwrap()
                .unwrap()
                .data,
            pending
        );
    }
    send_instruction(
        &mut context,
        &resolver,
        resolve(resolver.pubkey(), 1, 1, evidence, uri.to_string()),
        true,
    )
    .await;
    send_instruction(
        &mut context,
        &resolver,
        resolve(resolver.pubkey(), 1, 1, evidence, uri.to_string()),
        false,
    )
    .await;
    send_instruction(
        &mut context,
        &guardian,
        lifecycle(guardian.pubkey(), 4, [1; 32]),
        false,
    )
    .await;
    send_instruction(
        &mut context,
        &operator,
        lifecycle(operator.pubkey(), 4, [0; 32]),
        false,
    )
    .await;
    send_instruction(
        &mut context,
        &operator,
        lifecycle(operator.pubkey(), 4, [1; 32]),
        true,
    )
    .await;
    send_instruction(
        &mut context,
        &operator,
        lifecycle(operator.pubkey(), 255, [1; 32]),
        false,
    )
    .await;
    let account = context
        .banks_client
        .get_account(market)
        .await
        .unwrap()
        .unwrap();
    let state = Market::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(state.state, protocol_core::ARCHIVED);
    assert_eq!(state.payouts, [1, 1]);
    assert_eq!(state.resolution_commitment, [0; 32]);
    assert_eq!(state.evidence, evidence);
    assert_eq!(state.evidence_uri, uri);
    assert_eq!(state.resolved_at, 200);
}

#[tokio::test]
async fn delayed_admin_handoff_and_role_authority() {
    let mut program = ProgramTest::new("conditional_stocks", ID, processor!(host_entry));
    program.prefer_bpf(false);
    // Anchor 1.1's CPI implementation is SBF-only. Actual initialization is
    // exercised by local-validator.test.ts; preload its account shape here to
    // cover no-CPI governance with a precisely controlled Clock sysvar.
    let admin_key = Keypair::new();
    let admin = admin_key.pubkey();
    let (config, bump) = Pubkey::find_program_address(&[b"config", admin.as_ref()], &ID);
    let mut config_data = Vec::new();
    Config {
        seed_authority: admin,
        admin,
        quote_mint: Pubkey::new_unique(),
        roles: Roles {
            market_admin: admin,
            guardian: admin,
            resolution_admin: admin,
        },
        paused: false,
        maker_bps: 0,
        taker_bps: 0,
        pending_admin: Pubkey::default(),
        admin_after: 0,
        bump,
    }
    .try_serialize(&mut config_data)
    .unwrap();
    program.add_account(
        config,
        Account {
            lamports: 10_000_000,
            data: config_data,
            owner: ID,
            executable: false,
            rent_epoch: 0,
        },
    );
    program.add_account(
        admin,
        Account {
            lamports: 10_000_000,
            ..Account::default()
        },
    );
    let successor = Keypair::new();
    program.add_account(
        successor.pubkey(),
        Account {
            lamports: 10_000_000,
            ..Account::default()
        },
    );
    let context = program.start_with_context().await;
    let propose = Instruction {
        program_id: ID,
        accounts: accounts::Configure { admin, config }.to_account_metas(None),
        data: instruction::ProposeAdmin {
            successor: successor.pubkey(),
        }
        .data(),
    };
    let tx = Transaction::new_signed_with_payer(
        &[propose],
        Some(&admin),
        &[&admin_key],
        context.last_blockhash,
    );
    context.banks_client.process_transaction(tx).await.unwrap();
    let accept = Instruction {
        program_id: ID,
        accounts: accounts::AcceptAdmin {
            successor: successor.pubkey(),
            config,
        }
        .to_account_metas(None),
        data: instruction::AcceptAdmin {}.data(),
    };
    let tx = Transaction::new_signed_with_payer(
        std::slice::from_ref(&accept),
        Some(&admin),
        &[&admin_key, &successor],
        context.last_blockhash,
    );
    assert!(context.banks_client.process_transaction(tx).await.is_err());
    let mut clock: anchor_lang::prelude::Clock = context.banks_client.get_sysvar().await.unwrap();
    clock.unix_timestamp += ADMIN_DELAY;
    context.set_sysvar(&clock);
    // New payer changes the signature so the failed transaction cannot be served from the status cache.
    let tx = Transaction::new_signed_with_payer(
        &[accept],
        Some(&successor.pubkey()),
        &[&successor],
        context.last_blockhash,
    );
    context.banks_client.process_transaction(tx).await.unwrap();
    let account = context
        .banks_client
        .get_account(config)
        .await
        .unwrap()
        .unwrap();
    let state = Config::try_deserialize(&mut account.data.as_slice()).unwrap();
    assert_eq!(state.admin, successor.pubkey());
    assert_eq!(state.pending_admin, Pubkey::default());
    assert_eq!(state.admin_after, 0);
    assert_eq!(state.roles.guardian, admin); // Transferring admin does not silently transfer operational roles.
}
