//! Real Token-2022 mint account data for issuer tokens, built with the pinned
//! `spl_token_2022` interface (never hand-packed TLV), plus the raw mainnet
//! account bytes of the listed issuers. Shared by `issuer_policy` (host) and
//! `multi_issuer` (SBF).
#![allow(dead_code)]
use anchor_lang::prelude::Pubkey;
use anchor_lang::solana_program::program_option::COption;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        confidential_mint_burn::ConfidentialMintBurn,
        confidential_transfer::ConfidentialTransferMint,
        confidential_transfer_fee::ConfidentialTransferFeeConfig,
        default_account_state::DefaultAccountState,
        group_pointer::GroupPointer,
        interest_bearing_mint::InterestBearingConfig,
        metadata_pointer::MetadataPointer,
        mint_close_authority::MintCloseAuthority,
        non_transferable::NonTransferable,
        pausable::PausableConfig,
        permanent_delegate::PermanentDelegate,
        scaled_ui_amount::{PodF64, ScaledUiAmountConfig},
        transfer_fee::TransferFeeConfig,
        transfer_hook::TransferHook,
        BaseStateWithExtensionsMut, ExtensionType, StateWithExtensionsMut,
    },
    state::{AccountState, Mint},
};
use anchor_spl::token_2022_extensions::spl_token_metadata_interface::state::TokenMetadata;
use std::str::FromStr;

#[derive(Clone, Debug)]
pub enum Ext {
    MetadataPointer {
        authority: Option<Pubkey>,
        address: Option<Pubkey>,
    },
    PermanentDelegate(Pubkey),
    DefaultAccountState(AccountState),
    /// Multipliers are raw f64 bits so invalid encodings can be injected.
    ScaledUiAmount {
        authority: Option<Pubkey>,
        multiplier: u64,
        timestamp: i64,
        new_multiplier: u64,
    },
    Pausable {
        authority: Option<Pubkey>,
        paused: bool,
    },
    ConfidentialTransferMint {
        authority: Option<Pubkey>,
        auto_approve: bool,
    },
    TransferHook {
        authority: Option<Pubkey>,
        program_id: Option<Pubkey>,
    },
    TokenMetadata {
        update_authority: Option<Pubkey>,
        mint: Pubkey,
        name: String,
        symbol: String,
        uri: String,
    },
    /// Default-initialized fixed-size extension (unsupported or generic).
    Other(ExtensionType),
}

impl Ext {
    pub fn kind(&self) -> ExtensionType {
        match self {
            Ext::MetadataPointer { .. } => ExtensionType::MetadataPointer,
            Ext::PermanentDelegate(_) => ExtensionType::PermanentDelegate,
            Ext::DefaultAccountState(_) => ExtensionType::DefaultAccountState,
            Ext::ScaledUiAmount { .. } => ExtensionType::ScaledUiAmount,
            Ext::Pausable { .. } => ExtensionType::Pausable,
            Ext::ConfidentialTransferMint { .. } => ExtensionType::ConfidentialTransferMint,
            Ext::TransferHook { .. } => ExtensionType::TransferHook,
            Ext::TokenMetadata { .. } => ExtensionType::TokenMetadata,
            Ext::Other(kind) => *kind,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Issuer {
    pub decimals: u8,
    pub mint_authority: Option<Pubkey>,
    pub supply: u64,
    pub freeze_authority: Option<Pubkey>,
    pub extensions: Vec<Ext>,
}

pub fn key(address: &str) -> Pubkey {
    Pubkey::from_str(address).unwrap()
}

fn optional(key: Option<Pubkey>) -> COption<Pubkey> {
    key.map_or(COption::None, COption::Some)
}

impl Issuer {
    pub fn metadata(&self) -> Option<TokenMetadata> {
        self.extensions.iter().find_map(|e| match e {
            Ext::TokenMetadata {
                update_authority,
                mint,
                name,
                symbol,
                uri,
            } => Some(TokenMetadata {
                update_authority: (*update_authority).try_into().unwrap(),
                mint: *mint,
                name: name.clone(),
                symbol: symbol.clone(),
                uri: uri.clone(),
                additional_metadata: vec![],
            }),
            _ => None,
        })
    }

    /// Account bytes exactly as Token-2022 lays them out.
    pub fn build(&self) -> Vec<u8> {
        let fixed: Vec<_> = self
            .extensions
            .iter()
            .map(Ext::kind)
            .filter(|k| *k != ExtensionType::TokenMetadata)
            .collect();
        let metadata = self.metadata();
        let len = match &metadata {
            None => ExtensionType::try_calculate_account_len::<Mint>(&fixed).unwrap(),
            Some(m) => {
                // Base (165) + account type, fixed TLVs, then the Borsh-packed
                // variable-length metadata behind its 4-byte TLV header.
                let base = if fixed.is_empty() {
                    166
                } else {
                    ExtensionType::try_calculate_account_len::<Mint>(&fixed).unwrap()
                };
                let packed = 32 + 32 + 4 + m.name.len() + 4 + m.symbol.len() + 4 + m.uri.len() + 4;
                base + 4 + packed
            }
        };
        let mut data = vec![0u8; len];
        let mut state = StateWithExtensionsMut::<Mint>::unpack_uninitialized(&mut data).unwrap();
        for extension in &self.extensions {
            match extension {
                Ext::MetadataPointer { authority, address } => {
                    let e = state.init_extension::<MetadataPointer>(true).unwrap();
                    e.authority = (*authority).try_into().unwrap();
                    e.metadata_address = (*address).try_into().unwrap();
                }
                Ext::PermanentDelegate(delegate) => {
                    let e = state.init_extension::<PermanentDelegate>(true).unwrap();
                    e.delegate = Some(*delegate).try_into().unwrap();
                }
                Ext::DefaultAccountState(account_state) => {
                    let e = state.init_extension::<DefaultAccountState>(true).unwrap();
                    e.state = *account_state as u8;
                }
                Ext::ScaledUiAmount {
                    authority,
                    multiplier,
                    timestamp,
                    new_multiplier,
                } => {
                    let e = state.init_extension::<ScaledUiAmountConfig>(true).unwrap();
                    e.authority = (*authority).try_into().unwrap();
                    e.multiplier = PodF64(multiplier.to_le_bytes());
                    e.new_multiplier_effective_timestamp = (*timestamp).into();
                    e.new_multiplier = PodF64(new_multiplier.to_le_bytes());
                }
                Ext::Pausable { authority, paused } => {
                    let e = state.init_extension::<PausableConfig>(true).unwrap();
                    e.authority = (*authority).try_into().unwrap();
                    e.paused = (*paused).into();
                }
                Ext::ConfidentialTransferMint {
                    authority,
                    auto_approve,
                } => {
                    let e = state
                        .init_extension::<ConfidentialTransferMint>(true)
                        .unwrap();
                    e.authority = (*authority).try_into().unwrap();
                    e.auto_approve_new_accounts = (*auto_approve).into();
                }
                Ext::TransferHook {
                    authority,
                    program_id,
                } => {
                    let e = state.init_extension::<TransferHook>(true).unwrap();
                    e.authority = (*authority).try_into().unwrap();
                    e.program_id = (*program_id).try_into().unwrap();
                }
                Ext::TokenMetadata { .. } => {
                    state
                        .init_variable_len_extension(metadata.as_ref().unwrap(), false)
                        .unwrap();
                }
                Ext::Other(kind) => init_default(&mut state, *kind),
            }
        }
        state.base = Mint {
            mint_authority: optional(self.mint_authority),
            supply: self.supply,
            decimals: self.decimals,
            is_initialized: true,
            freeze_authority: optional(self.freeze_authority),
        };
        state.pack_base();
        state.init_account_type().unwrap();
        data
    }

    pub fn without(mut self, kind: ExtensionType) -> Self {
        self.extensions.retain(|e| e.kind() != kind);
        self
    }
    pub fn with(mut self, extension: Ext) -> Self {
        self.extensions.push(extension);
        self
    }
    pub fn paused(mut self, value: bool) -> Self {
        for e in &mut self.extensions {
            if let Ext::Pausable { paused, .. } = e {
                *paused = value;
            }
        }
        self
    }
    pub fn hook(mut self, program: Option<Pubkey>) -> Self {
        for e in &mut self.extensions {
            if let Ext::TransferHook { program_id, .. } = e {
                *program_id = program;
            }
        }
        self
    }
    pub fn scaled(mut self, old: u64, timestamp: i64, new: u64) -> Self {
        for e in &mut self.extensions {
            if let Ext::ScaledUiAmount {
                multiplier,
                timestamp: t,
                new_multiplier,
                ..
            } = e
            {
                (*multiplier, *t, *new_multiplier) = (old, timestamp, new);
            }
        }
        self
    }
    pub fn default_state(mut self, value: AccountState) -> Self {
        for e in &mut self.extensions {
            if let Ext::DefaultAccountState(s) = e {
                *s = value;
            }
        }
        self
    }
}

fn init_default(state: &mut StateWithExtensionsMut<Mint>, kind: ExtensionType) {
    match kind {
        ExtensionType::NonTransferable => {
            state.init_extension::<NonTransferable>(true).unwrap();
        }
        ExtensionType::InterestBearingConfig => {
            state.init_extension::<InterestBearingConfig>(true).unwrap();
        }
        ExtensionType::ConfidentialMintBurn => {
            state.init_extension::<ConfidentialMintBurn>(true).unwrap();
        }
        ExtensionType::MintCloseAuthority => {
            state.init_extension::<MintCloseAuthority>(true).unwrap();
        }
        ExtensionType::TransferFeeConfig => {
            state.init_extension::<TransferFeeConfig>(true).unwrap();
        }
        ExtensionType::ConfidentialTransferFeeConfig => {
            state
                .init_extension::<ConfidentialTransferFeeConfig>(true)
                .unwrap();
        }
        ExtensionType::GroupPointer => {
            state.init_extension::<GroupPointer>(true).unwrap();
        }
        other => panic!("no default initializer for {other:?}"),
    }
}

pub const NVDAX: &str = "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh";
pub const NVDAON: &str = "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo";
pub const NVDAR: &str = "ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu";
pub const SPCX: &str = "SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb";
/// PreStocks (pre-IPO; transfer fee next to confidential transfers, hence
/// ConfidentialTransferFeeConfig), read on 2026-09-25.
pub const PRESTOCKS_OPENAI: &str = "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF";
pub const PRESTOCKS_SPACEX: &str = "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh";
/// Tessera (pre-IPO loan participation token; transfer fee and metadata only).
pub const TESSERA_OPENAI: &str = "oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ";

/// NVDAx (xStocks), mainnet configuration read on 2026-09-23. Admitted 63.
pub fn nvdax() -> Issuer {
    let backed_key = key("5aMNNLQJwAEeoemTEMkv5NVjqKwvvefRYCQ5Z67HFvEq");
    let backed = Some(backed_key);
    Issuer {
        decimals: 8,
        mint_authority: Some(key("7pt9tkctJPK7PPNQJ77GKg8ZffSF6QxoMiCFYHxrtaCj")),
        supply: 32_127_474_793_063,
        freeze_authority: Some(key("JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs")),
        extensions: vec![
            Ext::MetadataPointer {
                authority: backed,
                address: Some(key(NVDAX)),
            },
            Ext::PermanentDelegate(backed_key),
            Ext::DefaultAccountState(AccountState::Initialized),
            Ext::ScaledUiAmount {
                authority: Some(key("S7vYFFWH6BjJyEsdrPQpqpYTqLTrPRK6KW3VwsJuRaS")),
                multiplier: 1.0009180758490996f64.to_bits(),
                timestamp: 1_789_000_200,
                new_multiplier: 1.001701196801074f64.to_bits(),
            },
            Ext::Pausable {
                authority: Some(key("JDq14BWvqCRFNu1krb12bcRpbGtJZ1FLEakMw6FdxJNs")),
                paused: false,
            },
            Ext::ConfidentialTransferMint {
                authority: backed,
                auto_approve: false,
            },
            Ext::TransferHook {
                authority: backed,
                program_id: None,
            },
            Ext::TokenMetadata {
                update_authority: backed,
                mint: key(NVDAX),
                name: "NVIDIA xStock".into(),
                symbol: "NVDAx".into(),
                uri: "https://xstocks-metadata.backed.fi/tokens/Solana/NVDAx/metadata.json".into(),
            },
        ],
    }
}

/// NVDAon (Ondo Global Markets). Admitted 62: no PermanentDelegate.
pub fn nvdaon() -> Issuer {
    let ondo = Some(key("9foMHsSDq7nMg4WPusSz9eY7tyxyukqborA8GyU5cUxD"));
    let m = 1.0017152487959897f64.to_bits();
    Issuer {
        decimals: 9,
        mint_authority: ondo,
        supply: 16_714_041_831_664,
        freeze_authority: Some(key("51QVCuHfL1FeNjd8BDeffCKhCcAYoULnVB3yjNhShiuK")),
        extensions: vec![
            Ext::ScaledUiAmount {
                authority: ondo,
                multiplier: m,
                timestamp: 1_788_998_645,
                new_multiplier: m,
            },
            Ext::MetadataPointer {
                authority: ondo,
                address: Some(key(NVDAON)),
            },
            Ext::Pausable {
                authority: ondo,
                paused: false,
            },
            Ext::DefaultAccountState(AccountState::Initialized),
            Ext::ConfidentialTransferMint {
                authority: ondo,
                auto_approve: false,
            },
            Ext::TransferHook {
                authority: ondo,
                program_id: None,
            },
            Ext::TokenMetadata {
                update_authority: ondo,
                mint: key(NVDAON),
                name: "NVIDIA (Ondo Tokenized)".into(),
                symbol: "NVDAon".into(),
                uri: "https://app.ondo.finance/api/v2/assets/NVDAon/sol_metadata.json".into(),
            },
        ],
    }
}

/// NVDAr (Remora). Admitted 47: no TransferHook.
pub fn nvdar() -> Issuer {
    let remora_key = key("DQSTm2WtpKBdpKx9t2cYL9Ja8fe7v4yEVEtA7NnSsdqb");
    let remora = Some(remora_key);
    Issuer {
        decimals: 9,
        mint_authority: remora,
        supply: 1_190_998_328_212,
        freeze_authority: remora,
        extensions: vec![
            Ext::MetadataPointer {
                authority: remora,
                address: Some(key(NVDAR)),
            },
            Ext::ScaledUiAmount {
                authority: remora,
                multiplier: 1f64.to_bits(),
                timestamp: 0,
                new_multiplier: 1f64.to_bits(),
            },
            Ext::Pausable {
                authority: remora,
                paused: false,
            },
            Ext::PermanentDelegate(remora_key),
            Ext::DefaultAccountState(AccountState::Initialized),
            Ext::ConfidentialTransferMint {
                authority: remora,
                auto_approve: false,
            },
            Ext::TokenMetadata {
                update_authority: remora,
                mint: key(NVDAR),
                name: "NVIDIA rStock".into(),
                symbol: "NVDAr".into(),
                uri: "https://remora-public.s3.us-east-2.amazonaws.com/solana/tokens/nvdar.json"
                    .into(),
            },
        ],
    }
}

/// Raw mainnet account bytes (base64 fixtures shared with the TypeScript SDK).
pub fn mainnet(address: &str) -> Vec<u8> {
    let json = match address {
        NVDAX => include_str!(
            "../../../../packages/solana-client/test/fixtures/mint-Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh.json"
        ),
        NVDAON => include_str!(
            "../../../../packages/solana-client/test/fixtures/mint-gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo.json"
        ),
        NVDAR => include_str!(
            "../../../../packages/solana-client/test/fixtures/mint-ALTP6gug9wv5mFtx2tSU1YYZ1NrEc2chDdMPoJA8f8pu.json"
        ),
        SPCX => include_str!(
            "../../../../packages/solana-client/test/fixtures/mint-SPCXxcqXj6e5dJDVNovHN8744zkbhM2bYudU45BimGb.json"
        ),
        PRESTOCKS_OPENAI => include_str!(
            "../../../../packages/solana-client/test/fixtures/mint-PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF.json"
        ),
        PRESTOCKS_SPACEX => include_str!(
            "../../../../packages/solana-client/test/fixtures/mint-PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh.json"
        ),
        TESSERA_OPENAI => include_str!(
            "../../../../packages/solana-client/test/fixtures/mint-oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ.json"
        ),
        other => panic!("no fixture for {other}"),
    };
    assert!(
        json.contains(&format!("\"address\": \"{address}\""))
            || json.contains(&format!("\"address\":\"{address}\""))
    );
    base64(json_string(json, "data"))
}

/// The string value of a top-level key in a flat JSON object.
fn json_string<'a>(json: &'a str, field: &str) -> &'a str {
    let tag = format!("\"{field}\"");
    let start = json.find(&tag).expect("field") + tag.len();
    let rest = json[start..]
        .trim_start()
        .strip_prefix(':')
        .unwrap()
        .trim_start();
    let rest = rest.strip_prefix('"').unwrap();
    &rest[..rest.find('"').unwrap()]
}

/// Standard (padded) base64 decoding.
pub fn base64(text: &str) -> Vec<u8> {
    fn value(c: u8) -> u32 {
        match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => panic!("invalid base64 byte {c}"),
        }
    }
    let bytes = text.as_bytes();
    assert_eq!(bytes.len() % 4, 0);
    let mut out = Vec::with_capacity(bytes.len() / 4 * 3);
    for chunk in bytes.chunks(4) {
        let pad = chunk.iter().rev().take_while(|c| **c == b'=').count();
        let mut n = 0u32;
        for (i, c) in chunk.iter().enumerate() {
            n |= if i < 4 - pad { value(*c) } else { 0 } << (18 - 6 * i);
        }
        let decoded = [(n >> 16) as u8, (n >> 8) as u8, n as u8];
        out.extend_from_slice(&decoded[..3 - pad]);
    }
    out
}
