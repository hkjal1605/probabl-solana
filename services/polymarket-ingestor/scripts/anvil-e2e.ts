import {
  manualResolutionControllerAbi,
  marketRegistryAbi,
} from "@conditional-stocks/contract-bindings";
import {
  type Address,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  keccak256,
  toBytes,
} from "viem";
import { mnemonicToAccount } from "viem/accounts";

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}`);
  return value;
};
const rpcUrl = required("ROBINHOOD_RPC_URL");
const chainId = Number(required("ROBINHOOD_CHAIN_ID"));
if (chainId !== 31_337) throw new Error("Milestone 12 E2E runs only on Anvil chain 31337");
const chain = defineChain({
  id: chainId,
  name: "Anvil",
  nativeCurrency: { decimals: 18, name: "Ether", symbol: "ETH" },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const publicClient = createPublicClient({ chain, transport: http(rpcUrl) });
const mnemonic =
  process.env.ANVIL_MNEMONIC ?? "test test test test test test test test test test test junk";
const marketAdmin = mnemonicToAccount(mnemonic, { addressIndex: 2 });
const marketWallet = createWalletClient({ account: marketAdmin, chain, transport: http(rpcUrl) });
const apiUrl = process.env.API_URL ?? "http://127.0.0.1:3000";
const indexerUrl = process.env.INDEXER_URL ?? "http://127.0.0.1:42069";
const registry = getAddress(required("MARKET_REGISTRY_ADDRESS"));
const stock = getAddress(required("STOCK_ADDRESS"));
const quote = getAddress(required("USDG_ADDRESS"));
const conditionId = keccak256(toBytes("milestone-12-polymarket-condition"));
const yesTokenId = "11111111111111111111111111111111111111111111111111111111111111111";
const noTokenId = "22222222222222222222222222222222222222222222222222222222222222222";

const gamma = {
  active: true,
  clobTokenIds: JSON.stringify([yesTokenId, noTokenId]),
  closed: false,
  conditionId,
  description: "Resolves Yes if the Milestone 12 fixture event occurs; otherwise No.",
  endDate: "2027-01-01T00:00:00Z",
  id: "m12-fixture",
  negRisk: false,
  outcomes: JSON.stringify(["Yes", "No"]),
  question: "Will the Milestone 12 fixture event occur?",
  resolutionSource: "Official fixture publication",
  slug: "milestone-12-fixture-event",
  umaResolutionStatus: "unresolved",
};
const mockSource = Bun.serve<{ sent: boolean }>({
  fetch(request, server) {
    const url = new URL(request.url);
    if (url.pathname === "/markets/m12-fixture") return Response.json(gamma);
    if (url.pathname === "/book" && url.searchParams.get("token_id") === yesTokenId) {
      return Response.json({
        asks: [{ price: "0.52", size: "1000" }],
        asset_id: yesTokenId,
        bids: [{ price: "0.48", size: "1000" }],
        hash: "m12-rest-book",
        market: conditionId,
        timestamp: Date.now().toString(),
      });
    }
    if (url.pathname === "/ws" && server.upgrade(request, { data: { sent: false } })) return;
    return new Response("not found", { status: 404 });
  },
  hostname: "127.0.0.1",
  port: 42_100,
  websocket: {
    message(socket) {
      if (socket.data.sent) return;
      socket.data.sent = true;
      socket.send(
        JSON.stringify({
          event_type: "price_change",
          market: conditionId,
          price_changes: [{ asset_id: yesTokenId, price: "0.49", side: "BUY", size: "1000" }],
          timestamp: Date.now().toString(),
        }),
      );
      setTimeout(() => {
        socket.send(
          JSON.stringify({
            assets_ids: [yesTokenId, noTokenId],
            event_type: "market_resolved",
            market: conditionId,
            timestamp: Date.now().toString(),
            winning_asset_id: yesTokenId,
            winning_outcome: "Yes",
          }),
        );
      }, 100);
    },
  },
});

const api = async <T>(
  path: string,
  options: { body?: unknown; method?: string; token?: string } = {},
): Promise<T> => {
  const response = await fetch(`${apiUrl}${path}`, {
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    headers: {
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      "content-type": "application/json",
    },
    method: options.method ?? (options.body === undefined ? "GET" : "POST"),
  });
  const body = (await response.json()) as T;
  if (!response.ok) throw new Error(`${path} returned ${response.status}: ${JSON.stringify(body)}`);
  return body;
};

const expectApiFailure = async (path: string, body: unknown, token: string): Promise<number> => {
  const response = await fetch(`${apiUrl}${path}`, {
    body: JSON.stringify(body),
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    method: "POST",
  });
  return response.status;
};

const authenticate = async (account: typeof marketAdmin): Promise<string> => {
  const challenge = await api<{ challengeId: string; message: string }>("/v1/auth/challenge", {
    body: { address: account.address },
  });
  const signature = await account.signMessage({ message: challenge.message });
  return (
    await api<{ token: string }>("/v1/auth/verify", {
      body: { address: account.address, challengeId: challenge.challengeId, signature },
    })
  ).token;
};

const waitFor = async <T>(label: string, action: () => Promise<T | null>): Promise<T> => {
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    const value = await action().catch(() => null);
    if (value !== null) return value;
    await Bun.sleep(400);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const execute = async (
  wallet: typeof marketWallet,
  transaction: { data: Hex; to: Address },
): Promise<Hex> => {
  const hash = await wallet.sendTransaction({
    account: wallet.account,
    chain,
    data: transaction.data,
    to: transaction.to,
    value: 0n,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
  return hash;
};

try {
  const preparerToken = await authenticate(marketAdmin);
  const reviewerToken = preparerToken;
  const outsiderToken = await authenticate(mnemonicToAccount(mnemonic, { addressIndex: 5 }));
  if (
    (await expectApiFailure(
      "/v1/admin/polymarket/metadata/fetch",
      { gammaMarketId: "m12-fixture" },
      outsiderToken,
    )) !== 403
  )
    throw new Error("A non-market-admin wallet was allowed to use the admin API");
  const metadata = await api<{ snapshotId: string }>("/v1/admin/polymarket/metadata/fetch", {
    body: { gammaMarketId: "m12-fixture" },
    token: preparerToken,
  });
  const block = await publicClient.getBlock();
  const creation = await api<{
    envelope: { packetHash: Hex };
  }>("/v1/admin/evidence/creation/prepare", {
    body: {
      attachments: [
        {
          contentBase64: Buffer.from(JSON.stringify(gamma)).toString("base64"),
          filename: "gamma-market.json",
          mediaType: "application/json",
        },
      ],
      config: {
        baseStep: (10n ** 18n).toString(),
        baseToken: stock,
        maxMarketOpenNotional: (1_000_000n * 10n ** 6n).toString(),
        maxOrderNotional: (100_000n * 10n ** 6n).toString(),
        maxOrderQuantity: (10_000n * 10n ** 18n).toString(),
        maxWalletOpenNotional: (250_000n * 10n ** 6n).toString(),
        metadataUri: "ipfs://milestone-12-market-metadata",
        minNotional: (10n ** 6n).toString(),
        priceTickRawX18: "10000",
        quoteToken: quote,
        rules: gamma.description,
        tradingCutoff: (block.timestamp + 7n * 24n * 60n * 60n).toString(),
        tradingOpen: block.timestamp.toString(),
      },
      metadataSnapshotId: metadata.snapshotId,
      sourceUrls: ["https://gamma-api.polymarket.com/markets/m12-fixture"],
    },
    token: preparerToken,
  });
  const creationHash = creation.envelope.packetHash;
  await api(`/v1/admin/evidence/${creationHash}/review`, {
    body: {
      checklist: {
        "condition-id": true,
        "rules-and-dates": true,
        "source-and-raw-hash": true,
        "stock-and-quote": true,
        "yes-no-orientation": true,
      },
      decision: "approve",
    },
    token: reviewerToken,
  });
  const creationTransaction = await api<{
    action: "create-market";
    chainId: number;
    data: Hex;
    expectedMarketId: Hex;
    from: Address;
    to: Address;
    value: "0";
  }>(`/v1/admin/evidence/${creationHash}/transaction`, { body: {}, token: preparerToken });
  const mismatchStatus = await expectApiFailure(
    `/v1/admin/evidence/${creationHash}/verify-transaction`,
    { ...creationTransaction, data: "0xdeadbeef" },
    reviewerToken,
  );
  if (mismatchStatus !== 409) throw new Error("tampered transaction was not rejected");
  await api(`/v1/admin/evidence/${creationHash}/verify-transaction`, {
    body: creationTransaction,
    token: reviewerToken,
  });
  const creationTxHash = await execute(marketWallet, creationTransaction);
  await waitFor("indexed manually created market", async () => {
    const response = await fetch(`${indexerUrl}/markets/${creationTransaction.expectedMarketId}`);
    return response.ok ? ((await response.json()) as object) : null;
  });
  await api(`/v1/admin/evidence/${creationHash}/reconcile`, {
    body: { action: "create-market", transactionHash: creationTxHash },
    token: preparerToken,
  });
  const attached = await waitFor("Polymarket probability", async () => {
    const response = await fetch(
      `${apiUrl}/v1/markets/${creationTransaction.expectedMarketId}/polymarket`,
    );
    if (!response.ok) return null;
    const result = (await response.json()) as {
      probability: { quality: string } | null;
    };
    return result.probability?.quality === "valid" ? result : null;
  });

  // The mock WebSocket emits a resolution-looking event. The local market must remain scheduled.
  await Bun.sleep(300);
  const stateAfterExternalResolutionEvent = await publicClient.readContract({
    abi: marketRegistryAbi,
    address: registry,
    args: [creationTransaction.expectedMarketId],
    functionName: "marketState",
  });
  if (stateAfterExternalResolutionEvent !== 1) {
    throw new Error("external data changed local market state automatically");
  }

  const freezeTxHash = await execute(marketWallet, {
    data: encodeFunctionData({
      abi: marketRegistryAbi,
      args: [creationTransaction.expectedMarketId, keccak256(toBytes("M12_MANUAL_FREEZE"))],
      functionName: "freezeMarket",
    }),
    to: registry,
  });
  await waitFor("frozen market", async () => {
    const response = await fetch(`${indexerUrl}/markets/${creationTransaction.expectedMarketId}`);
    if (!response.ok) return null;
    const value = (await response.json()) as { state: number };
    return value.state === 3 ? value : null;
  });

  const resolution = await api<{ envelope: { packetHash: Hex } }>(
    "/v1/admin/evidence/resolution/prepare",
    {
      body: {
        attachments: [
          {
            contentBase64: Buffer.from("human-verified-final-polygon-evidence").toString("base64"),
            filename: "polygon-verification.txt",
            mediaType: "text/plain",
          },
        ],
        marketId: creationTransaction.expectedMarketId,
        metadataSnapshotId: metadata.snapshotId,
        officialStatus: "resolved-final-after-dispute-window",
        officialUrl: "https://polymarket.com/event/milestone-12-fixture-event",
        payout: { denominator: "1", no: "0", yes: "1" },
        polygon: {
          blockNumber: "70000000",
          chainId: "137",
          conditionalTokensAddress: "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045",
          transactionHash: `0x${"77".repeat(32)}`,
        },
        sourceObservations: [
          {
            observedAt: new Date().toISOString(),
            payout: { denominator: "1", no: "0", yes: "1" },
            status: "final",
            url: "https://polymarket.com/event/milestone-12-fixture-event",
          },
        ],
        sourceReference: "ipfs://milestone-12-approved-resolution-packet",
      },
      token: preparerToken,
    },
  );
  const resolutionHash = resolution.envelope.packetHash;
  await api(`/v1/admin/evidence/${resolutionHash}/review`, {
    body: {
      checklist: {
        attachments: true,
        "condition-id": true,
        "final-status": true,
        "frozen-or-awaiting": true,
        "payout-vector": true,
        "polygon-reference": true,
        "yes-no-orientation": true,
      },
      decision: "approve",
    },
    token: reviewerToken,
  });
  const beginTransaction = await api<{ action: "begin-resolution"; data: Hex; to: Address }>(
    `/v1/admin/evidence/${resolutionHash}/transaction`,
    { body: {}, token: preparerToken },
  );
  const beginTxHash = await execute(marketWallet, beginTransaction);
  const expectedCommitment = await publicClient.readContract({
    abi: manualResolutionControllerAbi,
    address: getAddress(required("RESOLUTION_CONTROLLER_ADDRESS")),
    functionName: "hashResolution",
    args: [
      creationTransaction.expectedMarketId,
      1n,
      0n,
      1n,
      resolutionHash,
      "ipfs://milestone-12-approved-resolution-packet",
    ],
  });
  await waitFor("awaiting-resolution evidence anchor", async () => {
    const response = await fetch(`${indexerUrl}/markets/${creationTransaction.expectedMarketId}`);
    if (!response.ok) return null;
    const value = (await response.json()) as { state: number; stateReasonHash: Hex };
    return value.state === 4 && value.stateReasonHash === expectedCommitment ? value : null;
  });
  await api(`/v1/admin/evidence/${resolutionHash}/reconcile`, {
    body: { action: "begin-resolution", transactionHash: beginTxHash },
    token: preparerToken,
  });
  const resolveTransaction = await api<{ action: "resolve-market"; data: Hex; to: Address }>(
    `/v1/admin/evidence/${resolutionHash}/transaction`,
    { body: {}, token: reviewerToken },
  );
  const resolveTxHash = await execute(marketWallet, resolveTransaction);
  await waitFor("canonical manual resolution", async () => {
    const response = await fetch(
      `${indexerUrl}/resolutions/${creationTransaction.expectedMarketId}`,
    );
    if (!response.ok) return null;
    const value = (await response.json()) as { evidenceHash: Hex };
    return value.evidenceHash === resolutionHash ? value : null;
  });
  await api(`/v1/admin/evidence/${resolutionHash}/reconcile`, {
    body: { action: "resolve-market", transactionHash: resolveTxHash },
    token: reviewerToken,
  });
  const publicEvidence = await api<{ status: string }>(
    `/v1/markets/${creationTransaction.expectedMarketId}/resolution-evidence`,
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        creationEvidence: creationHash,
        externalResolutionEventChangedState: false,
        freezeTransaction: freezeTxHash,
        marketId: creationTransaction.expectedMarketId,
        probabilityQuality: attached.probability?.quality,
        resolutionEvidence: resolutionHash,
        resolutionEvidenceStatus: publicEvidence.status,
        result: "milestone-12-anvil-e2e-passed",
      },
      null,
      2,
    )}\n`,
  );
} finally {
  await mockSource.stop(true);
}
