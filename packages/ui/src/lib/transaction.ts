export const toRpcQuantity = (value: string | undefined): `0x${string}` => {
  if (value === undefined || value === "") return "0x0";
  if (!/^(?:0x[0-9a-fA-F]+|[0-9]+)$/.test(value)) {
    throw new Error("Transaction value is not a non-negative integer quantity.");
  }
  return `0x${BigInt(value).toString(16)}`;
};

export async function assertWalletContext(
  provider: { request(input: { method: string; params?: unknown[] }): Promise<unknown> },
  expectedAccount: string,
  expectedChainId: number,
): Promise<void> {
  const [accounts, chain] = await Promise.all([
    provider.request({ method: "eth_accounts" }),
    provider.request({ method: "eth_chainId" }),
  ]);
  if (
    !Array.isArray(accounts) ||
    typeof accounts[0] !== "string" ||
    accounts[0].toLowerCase() !== expectedAccount.toLowerCase()
  )
    throw new Error("Wallet account changed; reconnect and prepare the action again.");
  if (
    typeof chain !== "string" ||
    !/^0x[0-9a-fA-F]+$/.test(chain) ||
    BigInt(chain) !== BigInt(expectedChainId)
  )
    throw new Error("Wallet network changed; switch to the configured Robinhood network.");
}
