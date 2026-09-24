/** Mainnet identity of the issuer tokens this platform lists, read from Solana
 * mainnet and the issuers’ own metadata on 2026-09-24/25: the Token-2022
 * TokenMetadata (name, symbol, uri) on each mint, the JSON at that uri
 * (description, image), the effective ScaledUiAmount multiplier and the
 * transfer fee. Devnet replicas are created with exactly this identity
 * (scripts/solana/mock-issuers.ts) and the UI shows it with bundled copies of
 * the issuers’ logos (apps/ui/public/tokens/issuers).
 *
 * Display and fixture data only: never custody, listing or valuation authority
 * (that is the market’s on-chain leg list and the live mint state). */

export type IssuerName = "xStocks" | "Ondo Global Markets" | "PreStocks" | "Tessera";
export type IssuerTokenKind = "stock" | "etf" | "pre-ipo";

export interface CatalogToken {
  /** On-chain TokenMetadata symbol (e.g. "NVDAx", "OPENAI", "tOpenAI"). */
  symbol: string;
  /** On-chain TokenMetadata name. */
  name: string;
  issuer: IssuerName;
  /** Economic asset shared by every issuer token of one company (e.g. "NVDA", "OPENAI"). */
  asset: string;
  assetName: string;
  kind: IssuerTokenKind;
  /** Mainnet mint. */
  mint: string;
  decimals: number;
  /** On-chain metadata uri: the issuer-hosted JSON wallets read. */
  uri: string;
  /** Issuer-hosted image from that JSON. */
  image: string;
  /** Bundled copy of `image` served by the UI. */
  logo: string;
  /** Effective ScaledUiAmount multiplier on mainnet (1 without the extension). */
  multiplier: number;
  /** Current (newest scheduled) transfer fee in basis points. */
  transferFeeBps: number;
  /** `description` of the metadata JSON. */
  description: string;
}

export const ISSUER_TOKEN_CATALOG: readonly CatalogToken[] = Object.freeze(
  (
    [
      {
        symbol: "NVDAx",
        name: "NVIDIA xStock",
        issuer: "xStocks",
        asset: "NVDA",
        assetName: "NVIDIA",
        kind: "stock",
        mint: "Xsc9qvGR1efVDFGLrVsmkzv3qi45LTBjeUKSPmx9qEh",
        decimals: 8,
        uri: "https://xstocks-metadata.backed.fi/tokens/Solana/NVDAx/metadata.json",
        image: "https://xstocks-metadata.backed.fi/logos/tokens/NVDAx.png",
        logo: "/tokens/issuers/nvdax.png",
        multiplier: 1.001701196801074,
        transferFeeBps: 0,
        description:
          "NVIDIA xStock",
      },
      {
        symbol: "NVDAon",
        name: "NVIDIA (Ondo Tokenized)",
        issuer: "Ondo Global Markets",
        asset: "NVDA",
        assetName: "NVIDIA",
        kind: "stock",
        mint: "gEGtLTPNQ7jcg25zTetkbmF7teoDLcrfTnQfmn2ondo",
        decimals: 9,
        uri: "https://app.ondo.finance/api/v2/assets/NVDAon/sol_metadata.json",
        image: "https://cdn.ondo.finance/tokens/logos/nvdaon_160x160.png",
        logo: "/tokens/issuers/nvdaon.png",
        multiplier: 1.0017152487959897,
        transferFeeBps: 0,
        description:
          "NVIDIA Corporation stands as a prominent provider of advanced graphics, computational, and networking solutions, operating across the United States, Taiwan, China, and numerous international markets. Its Graphics division encompasses GeForce GPUs, central to PC gaming and personal computing experiences, along with the GeForce NOW cloud gaming service and its supporting infrastructure, as well as dedicated solutions for various gaming platforms. For professional visualization, it provides Quadro and NVIDIA RTX GPUs for enterprise workstations, further offering vGPU software designed for cloud-centric visual and virtual computing, automotive platforms for in-vehicle infotainment, and the Omniverse software suite, facilitating 3D design and virtual world creation. The Compute & Networking segment is a cornerstone for AI, high-performance computing (HPC), and accelerated data center platforms. It integrates Mellanox networking and interconnect solutions, delivers automotive AI Cockpit technologies, fosters autonomous driving development through strategic agreements, and offers comprehensive autonomous vehicle solutions. This segment also manufactures cryptocurrency mining processors, supplies Jetson platforms for robotics and other embedded applications, and offers enterprise AI software, including NVIDIA AI Enterprise. These diverse offerings find widespread application across the gaming, professional visualization, data center, and automotive sectors. NVIDIA distributes its portfolio through a broad ecosystem, engaging original equipment and device manufacturers, system integrators, add-in board makers, retail channels, software vendors, internet and cloud service providers, automotive companies (both manufacturers and tier-1 suppliers), mapping firms, nascent technology ventures, and other industry stakeholders. A notable strategic partnership exists with Kroger Co. Founded in 1993, NVIDIA Corporation maintains its corporate headquarters in Santa Clara, California.",
      },
      {
        symbol: "TSLAx",
        name: "Tesla xStock",
        issuer: "xStocks",
        asset: "TSLA",
        assetName: "Tesla",
        kind: "stock",
        mint: "XsDoVfqeBukxuZHWhdvWHBhgEHjGNst4MLodqsJHzoB",
        decimals: 8,
        uri: "https://xstocks-metadata.backed.fi/tokens/Solana/TSLAx/metadata.json",
        image: "https://xstocks-metadata.backed.fi/logos/tokens/TSLAx.png",
        logo: "/tokens/issuers/tslax.png",
        multiplier: 1,
        transferFeeBps: 0,
        description:
          "Tesla xStock",
      },
      {
        symbol: "TSLAon",
        name: "Tesla (Ondo Tokenized)",
        issuer: "Ondo Global Markets",
        asset: "TSLA",
        assetName: "Tesla",
        kind: "stock",
        mint: "KeGv7bsfR4MheC1CkmnAVceoApjrkvBhHYjWb67ondo",
        decimals: 9,
        uri: "https://app.ondo.finance/api/v2/assets/TSLAon/sol_metadata.json",
        image: "https://cdn.ondo.finance/tokens/logos/tslaon_160x160.png",
        logo: "/tokens/issuers/tslaon.png",
        multiplier: 1,
        transferFeeBps: 0,
        description:
          "Tesla, Inc. operates globally, specializing in the creation, production, and distribution of electric vehicles, alongside comprehensive energy generation and storage solutions. Its market reach extends across the United States, China, and various other international regions. The company's operations are primarily divided into two main segments: its Automotive business and its Energy Generation and Storage division. Within its Automotive division, Tesla not only provides a range of electric cars but also generates revenue from selling automotive regulatory credits. This segment further encompasses a variety of post-sale services, including non-warranty vehicle support, sales of pre-owned vehicles, various retail products, and car insurance offerings. Customers can acquire Tesla's sedans and sport utility vehicles through direct sales, purchases of used vehicles, or via in-app upgrades often facilitated by the extensive Tesla Supercharger network. The company supports these acquisitions with financing and leasing options. Furthermore, it ensures vehicle upkeep through its proprietary service centers and a fleet of mobile technicians, complemented by both standard and extended vehicle warranty programs. The Energy Generation and Storage segment focuses on the development, manufacturing, setup, sale, and rental of solar power systems and energy storage products, along with associated services. This caters to a diverse clientele, spanning residential users, commercial enterprises, industrial entities, and public utilities. Distribution channels include Tesla's online platform, physical stores, galleries, and a network of collaborative partners. The company also offers servicing and repairs for its energy products, including warranty support, and provides multiple financing avenues for those investing in its solar solutions. Founded in 2003, the corporation was initially named Tesla Motors, Inc., before officially rebranding to Tesla, Inc. in February 2017. Its corporate headquarters are situated in Austin, Texas.",
      },
      {
        symbol: "SPYx",
        name: "SP500 xStock",
        issuer: "xStocks",
        asset: "SPY",
        assetName: "SPDR S&P 500 ETF Trust",
        kind: "etf",
        mint: "XsoCS1TfEyfFhfvj8EtZ528L3CaKBDBRqRapnBbDF2W",
        decimals: 8,
        uri: "https://xstocks-metadata.backed.fi/tokens/Solana/SPYx/metadata.json",
        image: "https://xstocks-metadata.backed.fi/logos/tokens/SPYx.png",
        logo: "/tokens/issuers/spyx.png",
        multiplier: 1.005714560286254,
        transferFeeBps: 0,
        description:
          "SP500 xStock",
      },
      {
        symbol: "SPYon",
        name: "SPDR S&P 500 ETF (Ondo Tokenized)",
        issuer: "Ondo Global Markets",
        asset: "SPY",
        assetName: "SPDR S&P 500 ETF Trust",
        kind: "etf",
        mint: "k18WJUULWheRkSpSquYGdNNmtuE2Vbw1hpuUi92ondo",
        decimals: 9,
        uri: "https://app.ondo.finance/api/v2/assets/SPYon/sol_metadata.json",
        image: "https://cdn.ondo.finance/tokens/logos/spyon_160x160.png",
        logo: "/tokens/issuers/spyon.png",
        multiplier: 1.0094730727840426,
        transferFeeBps: 0,
        description:
          "SPY is the best-recognized and oldest US listed ETF and typically tops rankings for largest AUM and greatest trading volume. The fund tracks the massively popular US index, the S&P 500. Few realize that S&P's index committee chooses 500 securities to represent the US large-cap space - not necessarily the 500 largest by market cap, which can lead to some omissions of single names. Still, the index offers outstanding exposure to the US large-cap space. It's important to note, SPY is a unit investment trust, an older but entirely viable structure. As a UIT, SPY must fully replicate its index (it probably would anyway) and forgo the small risk and reward of securities lending. It also can`t reinvest portfolio dividends between distributions, the resulting cash drag will slightly hurt performance in up markets and help in downtrends. SPY is a favored vanilla trading vehicle.",
      },
      {
        symbol: "OPENAI",
        name: "OpenAI PreStocks",
        issuer: "PreStocks",
        asset: "OPENAI",
        assetName: "OpenAI",
        kind: "pre-ipo",
        mint: "PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF",
        decimals: 9,
        uri: "https://prestocks.com/metadata/openai.json",
        image: "https://prestocks.com/logos/openai.png",
        logo: "/tokens/issuers/openai.png",
        multiplier: 1.4861347,
        transferFeeBps: 300,
        description:
          "OpenAI PreStocks",
      },
      {
        symbol: "tOpenAI",
        name: "T-OpenAI",
        issuer: "Tessera",
        asset: "OPENAI",
        assetName: "OpenAI",
        kind: "pre-ipo",
        mint: "oPAiAikWTaFj9RYoRFD35ccfwhnMcB3ThgBZRHSkjTZ",
        decimals: 9,
        uri: "https://cdn.tesseralab.co/tessera/t-openai.json",
        image: "https://cdn.tesseralab.co/tessera/tokenicon_T-OpenAI.svg",
        logo: "/tokens/issuers/topenai.svg",
        multiplier: 1,
        transferFeeBps: 20,
        description:
          "T-OpenAI represents a loan participation right which provides economic exposure to OpenAI and is redeemable following divestment of the underlying exposure. This is a loan product, not a security - token holders have no ownership, voting, or dividend rights in OpenAI. By owning and using this token, you accept and agree to be bound by the Terms and Conditions available at https://terms.tessera.pe",
      },
      {
        symbol: "SPACEX",
        name: "SpaceX PreStocks",
        issuer: "PreStocks",
        asset: "SPACEX",
        assetName: "SpaceX",
        kind: "pre-ipo",
        mint: "PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh",
        decimals: 9,
        uri: "https://prestocks.com/metadata/spacex.json",
        image: "https://prestocks.com/logos/spacex.png",
        logo: "/tokens/issuers/spacex.png",
        multiplier: 5,
        transferFeeBps: 100,
        description:
          "SpaceX PreStocks",
      },
      {
        symbol: "tSpaceX",
        name: "T-SpaceX",
        issuer: "Tessera",
        asset: "SPACEX",
        assetName: "SpaceX",
        kind: "pre-ipo",
        mint: "TSPXcLV76s6V2zDiZQ18kBfcbnjaE2ZzNT3ga2Pd99v",
        decimals: 9,
        uri: "https://cdn.tesseralab.co/tessera/t-spacex.json",
        image: "https://cdn.tesseralab.co/tessera/tokenicon_T-SpaceX.svg",
        logo: "/tokens/issuers/tspacex.svg",
        multiplier: 1,
        transferFeeBps: 20,
        description:
          "T-SpaceX represents a loan participation right which provides economic exposure to SpaceX and is redeemable following divestment of the underlying exposure. This is a loan product, not a security - token holders have no ownership, voting, or dividend rights in SpaceX. By owning and using this token, you accept and agree to be bound by the Terms and Conditions available at https://terms.tessera.pe",
      },
      {
        symbol: "KALSHI",
        name: "Kalshi PreStocks",
        issuer: "PreStocks",
        asset: "KALSHI",
        assetName: "Kalshi",
        kind: "pre-ipo",
        mint: "PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua",
        decimals: 9,
        uri: "https://prestocks.com/metadata/kalshi.json",
        image: "https://prestocks.com/logos/kalshi.png",
        logo: "/tokens/issuers/kalshi.png",
        multiplier: 1,
        transferFeeBps: 300,
        description:
          "Kalshi PreStocks",
      },
      {
        symbol: "tKalshi",
        name: "T-Kalshi",
        issuer: "Tessera",
        asset: "KALSHI",
        assetName: "Kalshi",
        kind: "pre-ipo",
        mint: "TKLSidmLVt3cqGaaodG8tyRzoANfQwoh67AccjmubeZ",
        decimals: 9,
        uri: "https://cdn.tesseralab.co/tessera/t-kalshi.json",
        image: "https://cdn.tesseralab.co/tessera/tokenicon_T-Kalshi.svg",
        logo: "/tokens/issuers/tkalshi.svg",
        multiplier: 1,
        transferFeeBps: 20,
        description:
          "T-Kalshi represents a loan participation right which provides economic exposure to Kalshi and is redeemable following divestment of the underlying exposure. This is a loan product, not a security - token holders have no ownership, voting, or dividend rights in Kalshi. By owning and using this token, you accept and agree to be bound by the Terms and Conditions available at https://terms.tessera.pe",
      },
      {
        symbol: "ANTHROPIC",
        name: "Anthropic PreStocks",
        issuer: "PreStocks",
        asset: "ANTHROPIC",
        assetName: "Anthropic",
        kind: "pre-ipo",
        mint: "Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw",
        decimals: 9,
        uri: "https://prestocks.com/metadata/anthropic.json",
        image: "https://prestocks.com/logos/anthropic.png",
        logo: "/tokens/issuers/anthropic.png",
        multiplier: 1,
        transferFeeBps: 300,
        description:
          "Anthropic PreStocks",
      },
    ] satisfies CatalogToken[]
  ).map((token) => Object.freeze(token)),
);

const bySymbol = new Map(ISSUER_TOKEN_CATALOG.map((token) => [token.symbol, token]));
const byMint = new Map(ISSUER_TOKEN_CATALOG.map((token) => [token.mint, token]));

/** Catalog entry by on-chain symbol. */
export const catalogToken = (symbol: string): CatalogToken | undefined => bySymbol.get(symbol);
/** Catalog entry by mainnet mint. */
export const catalogTokenByMint = (mint: string): CatalogToken | undefined => byMint.get(mint);
/** Every catalog token of one economic asset, in listing order. */
export const catalogTokensForAsset = (asset: string): CatalogToken[] =>
  ISSUER_TOKEN_CATALOG.filter((token) => token.asset === asset);

/** Display name of an economic asset (e.g. "OPENAI" -> "OpenAI"). */
export function assetDisplayName(asset: string): string | undefined {
  return ISSUER_TOKEN_CATALOG.find((token) => token.asset === asset)?.assetName;
}

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Parses the devnet replica mint list written by the deployment scripts,
 * `SYMBOL=mint,SYMBOL=mint` (e.g. `NVDAx=4k2…,tOpenAI=9Zq…`). Unknown symbols,
 * malformed mints and duplicates are rejected, never guessed. */
export function parseReplicaMints(value: string | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  const mints = new Set<string>();
  for (const entry of (value ?? "").split(",").map((part) => part.trim()).filter(Boolean)) {
    const [symbol, mint, ...rest] = entry.split("=").map((part) => part.trim());
    if (rest.length || !symbol || !mint || !bySymbol.has(symbol) || !BASE58.test(mint))
      throw new Error(`Invalid issuer replica entry: ${entry}`);
    if (symbol in result || mints.has(mint)) throw new Error(`Duplicate issuer replica entry: ${entry}`);
    result[symbol] = mint;
    mints.add(mint);
  }
  return result;
}

/** Inverse of `parseReplicaMints`, in catalog order. */
export function formatReplicaMints(mints: Readonly<Record<string, string>>): string {
  return ISSUER_TOKEN_CATALOG.filter((token) => mints[token.symbol])
    .map((token) => `${token.symbol}=${mints[token.symbol]}`)
    .join(",");
}
