import { type Address, encodeFunctionData, getAddress, type Hex } from "viem";
import { hashResolutionCommitment } from "../../domain/src/resolution.ts";

import {
  createChainClients,
  createPublicChainClient,
  environmentAddress,
  environmentBigInt,
  environmentHex32,
  loadArtifact,
  requiredEnvironment,
  writeOutput,
} from "./lib.ts";

const controller = environmentAddress("RESOLUTION_CONTROLLER_ADDRESS");
const adminCaller = environmentAddress("ADMIN_CALLER_ADDRESS");
const marketId = environmentHex32("MARKET_ID");
const yesPayout = environmentBigInt("YES_PAYOUT");
const noPayout = environmentBigInt("NO_PAYOUT");
const payoutDenominator = environmentBigInt("PAYOUT_DENOMINATOR");
const evidenceHash = environmentHex32("EVIDENCE_HASH");
const evidenceUri = requiredEnvironment("EVIDENCE_URI");
const validVector =
  (yesPayout === 1n && noPayout === 0n && payoutDenominator === 1n) ||
  (yesPayout === 0n && noPayout === 1n && payoutDenominator === 1n) ||
  (yesPayout === 1n && noPayout === 1n && payoutDenominator === 2n);
if (!validVector) throw new Error("Resolution vector must be YES, NO, or invalid 50/50");

const { chainId, publicClient } = await createPublicChainClient();
const controllerArtifact = await loadArtifact("ManualResolutionController");
const resolutionArgs = [
  marketId,
  yesPayout,
  noPayout,
  payoutDenominator,
  evidenceHash,
  evidenceUri,
] as const;
const commitment = hashResolutionCommitment({
  chainId: BigInt(chainId),
  controller,
  marketId,
  yesPayout,
  noPayout,
  payoutDenominator,
  evidenceHash,
  evidenceUri,
});
const onchainCommitment = (await publicClient.readContract({
  abi: controllerArtifact.abi,
  address: controller,
  args: resolutionArgs,
  functionName: "hashResolution",
} as never)) as Hex;
if (commitment !== onchainCommitment) throw new Error("Resolution commitment encoding mismatch");
const prepare = Bun.argv.includes("--prepare");
const target = prepare
  ? ((await publicClient.readContract({
      abi: controllerArtifact.abi,
      address: controller,
      functionName: "registry",
    } as never)) as Address)
  : controller;
const artifact = prepare ? await loadArtifact("MarketRegistry") : controllerArtifact;
const args = prepare ? ([marketId, commitment] as const) : resolutionArgs;
const action = prepare ? "beginResolution" : "resolveMarket";
const calldata = encodeFunctionData({
  abi: artifact.abi,
  args,
  functionName: action,
} as never);

await publicClient.simulateContract({
  abi: artifact.abi,
  account: adminCaller,
  address: target,
  args,
  functionName: action,
} as never);

if (Bun.env.SUBMIT_ADMIN_ACTION !== "true") {
  writeOutput({
    action,
    calldata,
    chainId,
    commitment,
    evidenceHash,
    evidenceUri,
    from: adminCaller,
    marketId,
    mode: "simulation-only",
    payout: {
      denominator: payoutDenominator.toString(),
      no: noPayout.toString(),
      yes: yesPayout.toString(),
    },
    to: target,
  });
} else {
  const { account, chain, walletClient } = await createChainClients("ADMIN_PRIVATE_KEY");
  if (getAddress(account.address) !== adminCaller) {
    throw new Error("ADMIN_PRIVATE_KEY does not match ADMIN_CALLER_ADDRESS");
  }
  const hash = await walletClient.writeContract({
    abi: artifact.abi,
    account,
    address: target,
    args,
    chain,
    functionName: action,
  } as never);
  writeOutput({ action, chainId, commitment, marketId, transactionHash: hash });
}
