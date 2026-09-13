import { expect, test } from "bun:test";
import { type ConfigAccount, type Deployment, PROGRAM_ID } from "@conditional-stocks/solana-client";
import { Keypair } from "@solana/web3.js";
import { loadOperators, operatorRole } from "../src/lib/operator-access";

const addresses = [
  Keypair.generate().publicKey,
  Keypair.generate().publicKey,
  Keypair.generate().publicKey,
  Keypair.generate().publicKey,
  Keypair.generate().publicKey,
] as const;
const deployment: Deployment = {
  rpcUrl: "https://rpc.example.test",
  programId: PROGRAM_ID.toBase58(),
  config: addresses[0].toBase58(),
  genesisHash: "expected-genesis",
};
const config = {
  admin: addresses[0],
  roles: {
    market_admin: addresses[1],
    resolution_admin: addresses[2],
    guardian: addresses[3],
  },
} as ConfigAccount;

test("unconnected, pending and failed lookups are unverified, never blocked or authorized", () => {
  const owner = addresses[0].toBase58();
  expect(operatorRole(null, null)).toBe("unverified");
  expect(operatorRole(owner, null)).toBe("unverified");
  expect(operatorRole(null, [owner])).toBe("unverified");
  expect(operatorRole(owner, [])).toBe("blocked");
});

test("all four live roles work without public admin hints; unrelated wallets are blocked", async () => {
  const calls: string[] = [];
  const operators = await loadOperators(deployment, (settings) => {
    expect(settings).toBe(deployment);
    return {
      assertNetwork: async () => {
        calls.push("network");
      },
      configAccount: async () => {
        calls.push("config");
        return config;
      },
    };
  });
  expect(calls).toEqual(["network", "config"]);
  for (const address of addresses.slice(0, 4))
    expect(operatorRole(address.toBase58(), operators)).toBe("operator");
  expect(operatorRole(addresses[4].toBase58(), operators)).toBe("blocked");
});

test("missing deployment settings fail before RPC access with actionable configuration errors", async () => {
  let calls = 0;
  for (const [field, envKey] of [
    ["config", "NEXT_PUBLIC_SOLANA_CONFIG"],
    ["genesisHash", "NEXT_PUBLIC_SOLANA_GENESIS_HASH"],
    ["rpcUrl", "NEXT_PUBLIC_SOLANA_RPC_URL"],
  ] as const) {
    for (const value of ["", "   "]) {
      await expect(
        loadOperators({ ...deployment, [field]: value }, () => {
          calls++;
          throw new Error("Unexpected RPC call");
        }),
      ).rejects.toThrow(envKey);
    }
  }
  expect(calls).toBe(0);
});

test("network/genesis errors stop before role lookup and remain visible for retry", async () => {
  let reads = 0;
  for (const message of ["RPC offline", "RPC genesis hash differs from this deployment"]) {
    await expect(
      loadOperators(deployment, () => ({
        assertNetwork: async () => {
          throw new Error(message);
        },
        configAccount: async () => {
          reads++;
          return config;
        },
      })),
    ).rejects.toThrow(message);
  }
  expect(reads).toBe(0);
});

test("missing or foreign on-chain configuration cannot grant access via a public hint", async () => {
  const hintedDeployment = { ...deployment, marketAdmin: addresses[4].toBase58() };
  await expect(
    loadOperators(hintedDeployment, () => ({
      assertNetwork: async () => {},
      configAccount: async () => {
        throw new Error("Missing or foreign Config account");
      },
    })),
  ).rejects.toThrow("Missing or foreign Config account");
  const operators = await loadOperators(hintedDeployment, () => ({
    assertNetwork: async () => {},
    configAccount: async () => config,
  }));
  expect(operatorRole(hintedDeployment.marketAdmin, operators)).toBe("blocked");
});

test("a fresh role lookup honors authority rotation", async () => {
  const next = { ...config, admin: addresses[4] };
  const operators = await loadOperators(deployment, () => ({
    assertNetwork: async () => {},
    configAccount: async () => next,
  }));
  expect(operatorRole(config.admin.toBase58(), operators)).toBe("blocked");
  expect(operatorRole(next.admin.toBase58(), operators)).toBe("operator");
});
