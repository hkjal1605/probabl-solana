import {
  conditionalExchangeAbi,
  conditionalTokensAbi,
  manualResolutionControllerAbi,
  payoutVaultAbi,
} from "@conditional-stocks/contract-bindings";
import type {
  ReconciliationIssue,
  ReconciliationReport,
  ReconciliationSnapshot,
  SnapshotMarket,
} from "@conditional-stocks/db/reconciliation/types";
import { assertMarketUnits } from "@conditional-stocks/domain";
import { hashCanonical } from "@conditional-stocks/orderbook";
import { type Address, createPublicClient, erc20Abi, getAddress, type Hex, http } from "viem";
import type { IndexerEnvironment } from "../environment.ts";

export interface ReconciliationOptions {
  deep: boolean;
  exclusiveConditionalTokens: boolean;
}

interface ReadRequest {
  label: string;
  read: () => Promise<bigint>;
}

export const hashProjection = (snapshot: ReconciliationSnapshot): Hex =>
  hashCanonical({
    payoutCredits: [...snapshot.payoutCredits].sort((a, b) =>
      `${a.beneficiary}:${a.asset}:${a.tokenId}`.localeCompare(
        `${b.beneficiary}:${b.asset}:${b.tokenId}`,
      ),
    ),
    payoutTotals: [...snapshot.payoutTotals].sort((a, b) =>
      `${a.asset}:${a.tokenId}`.localeCompare(`${b.asset}:${b.tokenId}`),
    ),
    claimTotals: [...snapshot.claimTotals].sort((left, right) =>
      left.positionId.localeCompare(right.positionId),
    ),
    deep: snapshot.deep,
    indexedBlock: snapshot.state.indexedBlock,
    indexedBlockHash: snapshot.state.indexedBlockHash,
    marketOpenInterest: [...snapshot.marketOpenInterest].sort((left, right) =>
      left.marketId.localeCompare(right.marketId),
    ),
    markets: [...snapshot.markets].sort((left, right) => left.id.localeCompare(right.id)),
    openOrders: [...snapshot.openOrders].sort((left, right) => left.id.localeCompare(right.id)),
    projectionVersion: 3,
    reservationTotals: [...snapshot.reservationTotals].sort((left, right) =>
      `${left.assetAddress}:${left.tokenId ?? "erc20"}`.localeCompare(
        `${right.assetAddress}:${right.tokenId ?? "erc20"}`,
      ),
    ),
    reservations: [...snapshot.reservations].sort((left, right) =>
      left.orderHash.localeCompare(right.orderHash),
    ),
    resolutions: [...snapshot.resolutions].sort((left, right) =>
      left.marketId.localeCompare(right.marketId),
    ),
    walletOpenInterest: [...snapshot.walletOpenInterest].sort((left, right) =>
      `${left.marketId}:${left.account}`.localeCompare(`${right.marketId}:${right.account}`),
    ),
  });

const canonicalAddress = (value: Address): string => getAddress(value).toLowerCase();
const marketScope = (marketId: Hex): string => `market:${marketId.toLowerCase()}`;

const marketScopesForAsset = (markets: SnapshotMarket[], asset: Address): string[] => {
  const canonical = canonicalAddress(asset);
  return markets
    .filter(
      (market) =>
        canonicalAddress(market.baseToken) === canonical ||
        canonicalAddress(market.quoteToken) === canonical,
    )
    .map((market) => marketScope(market.id));
};

const issue = (
  issues: ReconciliationIssue[],
  value: Omit<ReconciliationIssue, "severity"> & { severity?: ReconciliationIssue["severity"] },
): void => {
  issues.push({ severity: "critical", ...value });
};

const requiredPositionIds = (market: SnapshotMarket): bigint[] => {
  const values = [
    market.stockYesPositionId,
    market.stockNoPositionId,
    market.quoteYesPositionId,
    market.quoteNoPositionId,
  ];
  if (values.some((value) => value === null)) return [];
  return values.map((value) => BigInt(value as string));
};

export const runReconciliation = async (
  snapshot: ReconciliationSnapshot,
  environment: IndexerEnvironment,
  options: ReconciliationOptions,
): Promise<ReconciliationReport> => {
  const startedAt = new Date().toISOString();
  const projectionHash = hashProjection(snapshot);
  const issues: ReconciliationIssue[] = [];
  const client = createPublicClient({
    transport: http(environment.rpcUrls[0], { batch: true }),
  });
  const blockNumber = BigInt(snapshot.state.indexedBlock);
  for (const market of snapshot.markets) {
    assertMarketUnits(market);
    const [baseDecimals, quoteDecimals] = await Promise.all([
      client.readContract({
        abi: erc20Abi,
        address: market.baseToken,
        functionName: "decimals",
        blockNumber,
      }),
      client.readContract({
        abi: erc20Abi,
        address: market.quoteToken,
        functionName: "decimals",
        blockNumber,
      }),
    ]);
    if (baseDecimals !== market.baseTokenDecimals || quoteDecimals !== market.quoteTokenDecimals) {
      issue(issues, {
        code: "TOKEN_UNIT_METADATA_CHANGED",
        actual: `${baseDecimals}/${quoteDecimals}`,
        expected: `${market.baseTokenDecimals}/${market.quoteTokenDecimals}`,
        details:
          "Token metadata differs from market-creation metadata; raw accounting is unchanged but human price display must be reviewed",
        freezeScope: marketScope(market.id),
      });
    }
  }

  const custodyAssets = new Map<string, { assetAddress: Address; tokenId: string | null }>();
  const addCustodyAsset = (assetAddress: Address, tokenId: string | null): void => {
    const key = `${canonicalAddress(assetAddress)}:${tokenId ?? "erc20"}`;
    custodyAssets.set(key, { assetAddress, tokenId });
  };
  for (const market of snapshot.markets) {
    addCustodyAsset(market.baseToken, null);
    addCustodyAsset(market.quoteToken, null);
    const positions = requiredPositionIds(market);
    if (positions.length === 4) {
      addCustodyAsset(market.baseToken, positions[0]?.toString() ?? null);
      addCustodyAsset(market.baseToken, positions[1]?.toString() ?? null);
      addCustodyAsset(market.quoteToken, positions[2]?.toString() ?? null);
      addCustodyAsset(market.quoteToken, positions[3]?.toString() ?? null);
    }
  }
  for (const reservation of snapshot.reservationTotals) {
    addCustodyAsset(reservation.assetAddress, reservation.tokenId);
  }
  const expectedCustody = new Map(
    snapshot.reservationTotals.map((reservation) => [
      `${canonicalAddress(reservation.assetAddress)}:${reservation.tokenId ?? "erc20"}`,
      BigInt(reservation.amount ?? "0"),
    ]),
  );
  const custodyEntries = [...custodyAssets.entries()];
  const custodyReads: ReadRequest[] = custodyEntries.map(([label, asset]) => ({
    label,
    read:
      asset.tokenId === null
        ? () =>
            client.readContract({
              abi: erc20Abi,
              address: asset.assetAddress,
              args: [environment.contracts.exchange],
              blockNumber,
              functionName: "balanceOf",
            })
        : () =>
            client.readContract({
              abi: conditionalTokensAbi,
              address: environment.contracts.conditionalTokens,
              args: [environment.contracts.exchange, BigInt(asset.tokenId as string)],
              blockNumber,
              functionName: "balanceOf",
            }),
  }));
  const custodyBalances = await Promise.all(custodyReads.map((request) => request.read()));
  for (let index = 0; index < custodyReads.length; index += 1) {
    const request = custodyReads[index];
    const custodyEntry = custodyEntries[index];
    const actual = custodyBalances[index];
    if (!request || !custodyEntry || actual === undefined) throw new Error("custody read mismatch");
    const [custodyKey, asset] = custodyEntry;
    const expected = expectedCustody.get(custodyKey) ?? 0n;
    if (actual !== expected) {
      const scopes = marketScopesForAsset(snapshot.markets, asset.assetAddress);
      const donation = asset.tokenId === null && actual > expected;
      issue(issues, {
        actual: actual.toString(),
        code: donation ? "EXCHANGE_COLLATERAL_DONATION" : "EXCHANGE_CUSTODY_MISMATCH",
        details: `exchange custody ${request.label} differs from summed open reservations`,
        expected: expected.toString(),
        freezeScope: donation ? null : (scopes[0] ?? "global"),
        severity: donation ? "warning" : "critical",
      });
    }
  }

  const claimTotals = new Map(
    snapshot.claimTotals.map((row) => [row.positionId, BigInt(row.amount ?? "0")]),
  );
  const resolutions = new Map(
    snapshot.resolutions.map((resolution) => [resolution.marketId.toLowerCase(), resolution]),
  );
  const liabilities = new Map<string, bigint>();
  for (const market of snapshot.markets) {
    const positions = requiredPositionIds(market);
    if (positions.length !== 4) {
      issue(issues, {
        actual: positions.length.toString(),
        code: "MARKET_POSITION_CONFIGURATION_INCOMPLETE",
        details: `market ${market.id} does not have four indexed position IDs`,
        expected: "4",
        freezeScope: marketScope(market.id),
      });
      continue;
    }
    const [stockYesId, stockNoId, quoteYesId, quoteNoId] = positions as [
      bigint,
      bigint,
      bigint,
      bigint,
    ];
    const pairs = [
      [market.baseToken, stockYesId, stockNoId],
      [market.quoteToken, quoteYesId, quoteNoId],
    ] as const;
    const resolution = resolutions.get(market.id.toLowerCase());
    for (const [token, yesId, noId] of pairs) {
      const yesSupply = claimTotals.get(yesId.toString()) ?? 0n;
      const noSupply = claimTotals.get(noId.toString()) ?? 0n;
      let liability: bigint;
      if (resolution) {
        const denominator = BigInt(resolution.payoutDenominator);
        liability =
          (yesSupply * BigInt(resolution.yesPayout)) / denominator +
          (noSupply * BigInt(resolution.noPayout)) / denominator;
      } else {
        if (yesSupply !== noSupply) {
          issue(issues, {
            actual: `${yesSupply}/${noSupply}`,
            code: "UNRESOLVED_CLAIM_SUPPLY_MISMATCH",
            details: `YES/NO supply differs for ${market.id} and ${token}`,
            expected: "equal",
            freezeScope: marketScope(market.id),
          });
        }
        liability = yesSupply;
      }
      const key = canonicalAddress(token);
      liabilities.set(key, (liabilities.get(key) ?? 0n) + liability);
    }
  }

  const liabilityEntries = [...liabilities.entries()] as Array<[string, bigint]>;
  const lockedBalances = await Promise.all(
    liabilityEntries.map(([token]) =>
      client.readContract({
        abi: erc20Abi,
        address: token as Address,
        args: [environment.contracts.conditionalTokens],
        blockNumber,
        functionName: "balanceOf",
      }),
    ),
  );
  for (let index = 0; index < liabilityEntries.length; index += 1) {
    const entry = liabilityEntries[index];
    const actual = lockedBalances[index];
    if (!entry || actual === undefined) throw new Error("liability read mismatch");
    const [token, expected] = entry;
    // Anyone can donate ERC-20 collateral directly, and pro-rata redemptions may
    // leave rounding dust. Excess backing is not insolvency or a safe freeze signal.
    if (actual < expected || (options.exclusiveConditionalTokens && actual > expected)) {
      const surplus = actual > expected;
      issue(issues, {
        actual: actual.toString(),
        code: surplus ? "CTF_COLLATERAL_SURPLUS" : "CTF_COLLATERAL_LIABILITY_MISMATCH",
        details: surplus
          ? `CTF collateral ${token} includes unallocated backing or redemption dust`
          : `CTF collateral ${token} is below product liabilities`,
        expected: `at least ${expected}`,
        severity: surplus ? "warning" : "critical",
        freezeScope: surplus
          ? null
          : (marketScopesForAsset(snapshot.markets, token as Address)[0] ?? "global"),
      });
    }
  }

  const uniqueTokens = new Set(
    snapshot.markets.flatMap((market) => [
      canonicalAddress(market.baseToken),
      canonicalAddress(market.quoteToken),
    ]),
  );
  const uniquePositionIds = new Set(
    snapshot.markets.flatMap((market) => requiredPositionIds(market).map(String)),
  );
  // Credits are ownership within vault custody, not additional CTF supply. Compare the
  // separate liability ledger and actual backing, including known assets with zero DB rows
  // so a missed first PayoutDeferred event cannot disappear from reconciliation.
  const payoutAssets = new Map<string, { asset: Address; tokenId: bigint }>();
  const payoutKey = (asset: Address, id: bigint) => `${canonicalAddress(asset)}:${id}`;
  const addPayoutAsset = (asset: Address, tokenId: bigint) =>
    payoutAssets.set(payoutKey(asset, tokenId), { asset, tokenId });
  for (const token of uniqueTokens) addPayoutAsset(token as Address, 0n);
  for (const id of uniquePositionIds)
    addPayoutAsset(environment.contracts.conditionalTokens, BigInt(id));
  for (const row of snapshot.payoutTotals) addPayoutAsset(row.asset, BigInt(row.tokenId));
  const expectedPayouts = new Map(
    snapshot.payoutTotals.map((row) => [
      payoutKey(row.asset, BigInt(row.tokenId)),
      BigInt(row.amount),
    ]),
  );
  await Promise.all(
    [...payoutAssets.values()].map(async ({ asset, tokenId }) => {
      const ctfAsset =
        canonicalAddress(asset) === canonicalAddress(environment.contracts.conditionalTokens);
      const [liability, backing] = await Promise.all([
        client.readContract({
          abi: payoutVaultAbi,
          address: environment.contracts.payoutVault,
          functionName: "totalClaimable",
          args: [asset, tokenId],
          blockNumber,
        }),
        ctfAsset
          ? client.readContract({
              abi: conditionalTokensAbi,
              address: asset,
              functionName: "balanceOf",
              args: [environment.contracts.payoutVault, tokenId],
              blockNumber,
            })
          : client.readContract({
              abi: erc20Abi,
              address: asset,
              functionName: "balanceOf",
              args: [environment.contracts.payoutVault],
              blockNumber,
            }),
      ]);
      const expected = expectedPayouts.get(payoutKey(asset, tokenId)) ?? 0n;
      if (liability !== expected)
        issue(issues, {
          code: "PAYOUT_LIABILITY_MISMATCH",
          actual: String(liability),
          expected: String(expected),
          details: `vault ${asset}:${tokenId} liabilities differ from indexed beneficiary credits`,
          freezeScope: "global",
        });
      if (backing < liability || (ctfAsset && backing !== liability))
        issue(issues, {
          code: "PAYOUT_BACKING_MISMATCH",
          actual: String(backing),
          expected: ctfAsset ? String(liability) : `at least ${liability}`,
          details: `vault ${asset}:${tokenId} custody does not back its outstanding credits`,
          freezeScope: "global",
        });
    }),
  );
  const residualReads: Array<{ asset: string; holder: Address; read: () => Promise<bigint> }> = [];
  for (const holder of [environment.contracts.settlement, environment.contracts.positionRouter]) {
    for (const token of uniqueTokens) {
      residualReads.push({
        asset: token,
        holder,
        read: () =>
          client.readContract({
            abi: erc20Abi,
            address: token as Address,
            args: [holder],
            blockNumber,
            functionName: "balanceOf",
          }),
      });
    }
    for (const positionId of uniquePositionIds) {
      residualReads.push({
        asset: `ctf:${positionId}`,
        holder,
        read: () =>
          client.readContract({
            abi: conditionalTokensAbi,
            address: environment.contracts.conditionalTokens,
            args: [holder, BigInt(positionId)],
            blockNumber,
            functionName: "balanceOf",
          }),
      });
    }
  }
  const residuals = await Promise.all(residualReads.map((request) => request.read()));
  for (let index = 0; index < residualReads.length; index += 1) {
    const request = residualReads[index];
    const actual = residuals[index];
    if (!request || actual === undefined) throw new Error("residual read mismatch");
    if (actual !== 0n) {
      const donation = !request.asset.startsWith("ctf:");
      issue(issues, {
        actual: actual.toString(),
        code: donation ? "ROUTER_COLLATERAL_DONATION" : "ROUTER_RESIDUAL_BALANCE",
        details: `${request.holder} retained unexpected ${request.asset}`,
        expected: "0",
        freezeScope: donation ? null : "global",
        severity: donation ? "warning" : "critical",
      });
    }
  }

  if (options.deep) {
    await Promise.all(
      snapshot.payoutCredits.map(async (row) => {
        const amount = await client.readContract({
          abi: payoutVaultAbi,
          address: environment.contracts.payoutVault,
          functionName: "claimable",
          args: [row.beneficiary, row.asset, BigInt(row.tokenId)],
          blockNumber,
        });
        if (amount !== BigInt(row.amount))
          issue(issues, {
            code: "PAYOUT_BENEFICIARY_MISMATCH",
            actual: String(amount),
            expected: row.amount,
            details: `vault credit owner ${row.beneficiary} for ${row.asset}:${row.tokenId} differs from projection`,
            freezeScope: "global",
          });
      }),
    );
    const projectedMarketInterest = new Map(
      snapshot.marketOpenInterest.map((row) => [row.marketId.toLowerCase(), BigInt(row.amount)]),
    );
    const marketInterest = await Promise.all(
      snapshot.markets.map((row) =>
        client.readContract({
          abi: conditionalExchangeAbi,
          address: environment.contracts.exchange,
          args: [row.id],
          blockNumber,
          functionName: "marketOpenNotional",
        }),
      ),
    );
    for (let index = 0; index < snapshot.markets.length; index += 1) {
      const market = snapshot.markets[index];
      const actual = marketInterest[index];
      if (!market || actual === undefined) throw new Error("market interest read mismatch");
      const expected = projectedMarketInterest.get(market.id.toLowerCase()) ?? 0n;
      if (actual !== expected) {
        issue(issues, {
          actual: actual.toString(),
          code: "MARKET_OPEN_INTEREST_MISMATCH",
          details: `market ${market.id} open notional differs from projection`,
          expected: expected.toString(),
          freezeScope: marketScope(market.id),
        });
      }
    }

    const walletInterest = await Promise.all(
      snapshot.walletOpenInterest.map((row) =>
        client.readContract({
          abi: conditionalExchangeAbi,
          address: environment.contracts.exchange,
          args: [row.marketId, row.account],
          blockNumber,
          functionName: "walletOpenNotional",
        }),
      ),
    );
    for (let index = 0; index < snapshot.walletOpenInterest.length; index += 1) {
      const row = snapshot.walletOpenInterest[index];
      const actual = walletInterest[index];
      if (!row || actual === undefined) throw new Error("wallet interest read mismatch");
      if (actual !== BigInt(row.amount)) {
        issue(issues, {
          actual: actual.toString(),
          code: "WALLET_OPEN_INTEREST_MISMATCH",
          details: `wallet ${row.account} open notional differs for ${row.marketId}`,
          expected: row.amount,
          freezeScope: marketScope(row.marketId),
        });
      }
    }

    const reservationByOrder = new Map(
      snapshot.reservations.map((reservation) => [
        reservation.orderHash.toLowerCase(),
        reservation,
      ]),
    );
    const states = await Promise.all(
      snapshot.openOrders.map((order) =>
        client.readContract({
          abi: conditionalExchangeAbi,
          address: environment.contracts.exchange,
          args: [order.id],
          blockNumber,
          functionName: "getOrderState",
        }),
      ),
    );
    for (let index = 0; index < snapshot.openOrders.length; index += 1) {
      const order = snapshot.openOrders[index];
      const state = states[index];
      if (!order || !state) throw new Error("order state read mismatch");
      const reservation = reservationByOrder.get(order.id.toLowerCase());
      const mismatches = [
        ["maker", state.maker.toLowerCase(), order.maker.toLowerCase()],
        ["marketId", state.marketId.toLowerCase(), order.marketId.toLowerCase()],
        ["reserved", state.reserved.toString(), order.reserved],
        ["openNotional", state.openNotional.toString(), order.openNotional],
        ["remaining", state.remaining.toString(), order.remaining],
        ["limitPriceRawX18", state.limitPriceRawX18.toString(), order.limitPriceRawX18],
        ["sequence", state.sequence.toString(), order.sequence],
        ["nonce", state.nonce.toString(), order.nonce],
        ["branch", state.branch.toString(), order.branch.toString()],
        ["side", state.side.toString(), order.side.toString()],
        ["fundingKind", state.fundingKind.toString(), order.fundingKind.toString()],
        ["status", state.status.toString(), "1"],
        ["reservation", reservation?.amount ?? "missing", order.reserved],
      ].filter(([, actual, expected]) => actual !== expected);
      if (mismatches.length > 0) {
        issue(issues, {
          actual: mismatches.map(([field, actual]) => `${field}=${actual}`).join(","),
          code: "ORDER_STATE_MISMATCH",
          details: `order ${order.id} differs between chain and projection`,
          expected: mismatches.map(([field, , expected]) => `${field}=${expected}`).join(","),
          freezeScope: marketScope(order.marketId),
        });
      }
    }

    await Promise.all(
      snapshot.resolutions.map(async (resolution) => {
        const resolvedMarket = snapshot.markets.find(
          (market) => market.id.toLowerCase() === resolution.marketId.toLowerCase(),
        );
        if (!resolvedMarket) {
          issue(issues, {
            actual: "missing",
            code: "RESOLUTION_MARKET_MISSING",
            details: `resolution ${resolution.marketId} references no projected market`,
            expected: "market",
            freezeScope: marketScope(resolution.marketId),
          });
          return;
        }
        const [resolved, denominator, yes, no] = await Promise.all([
          client.readContract({
            abi: manualResolutionControllerAbi,
            address: environment.contracts.resolutionController,
            args: [resolution.marketId],
            blockNumber,
            functionName: "resolved",
          }),
          client.readContract({
            abi: conditionalTokensAbi,
            address: environment.contracts.conditionalTokens,
            args: [resolvedMarket.conditionId],
            blockNumber,
            functionName: "payoutDenominator",
          }),
          client.readContract({
            abi: conditionalTokensAbi,
            address: environment.contracts.conditionalTokens,
            args: [resolvedMarket.conditionId, 0n],
            blockNumber,
            functionName: "payoutNumerators",
          }),
          client.readContract({
            abi: conditionalTokensAbi,
            address: environment.contracts.conditionalTokens,
            args: [resolvedMarket.conditionId, 1n],
            blockNumber,
            functionName: "payoutNumerators",
          }),
        ]);
        if (
          !resolved ||
          denominator.toString() !== resolution.payoutDenominator ||
          yes.toString() !== resolution.yesPayout ||
          no.toString() !== resolution.noPayout
        ) {
          issue(issues, {
            actual: `${resolved}/${yes}/${no}/${denominator}`,
            code: "RESOLUTION_EVIDENCE_MISMATCH",
            details: `resolution ${resolution.marketId} differs from controller/CTF state`,
            expected: `true/${resolution.yesPayout}/${resolution.noPayout}/${resolution.payoutDenominator}`,
            freezeScope: marketScope(resolution.marketId),
          });
        }
      }),
    );
  }

  const freezeScopes = [
    ...new Set(
      issues
        .filter((entry) => entry.severity === "critical" && entry.freezeScope !== null)
        .map((entry) => entry.freezeScope as string),
    ),
  ].sort();
  return {
    chainId: environment.chainId,
    completedAt: new Date().toISOString(),
    deep: options.deep,
    freezeRequired: freezeScopes.length > 0,
    freezeScopes,
    indexedBlock: snapshot.state.indexedBlock,
    indexedBlockHash: snapshot.state.indexedBlockHash,
    issues,
    projectionHash,
    projectionVersion: 3,
    startedAt,
    status: issues.some((entry) => entry.severity === "critical") ? "mismatch" : "ok",
  };
};
