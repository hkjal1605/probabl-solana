"use client";

import { formatTokenAmount } from "@conditional-stocks/domain";
import { useWallet } from "@/components/providers/WalletProvider";
import { toast } from "@/components/ui/toast";
import type { WalletAsset, WalletAssetBalance } from "@/hooks/useWalletAssets";
import { vaultAmount, verifiedVaultTransaction } from "@/lib/trading/vault";
import { refreshStores } from "@/stores/createResourceStore";
import { useAsyncAction } from "./useAsyncAction";

export interface VaultSelection {
  action: "deposit" | "withdraw";
  asset: WalletAsset;
}

export function useVaultTransfer({
  selection,
  amount,
  balances,
  fresh,
  refresh,
  onSuccess,
}: {
  selection: VaultSelection | null;
  amount: string;
  balances: WalletAssetBalance[];
  fresh: boolean;
  refresh: () => Promise<unknown>;
  onSuccess: () => void;
  loadNativeBalance?: boolean;
}) {
  const wallet = useWallet();
  const balance = balances.find((row) => row.token === selection?.asset.token)?.balance;
  const { busy, run } = useAsyncAction(
    [wallet.account, selection?.asset.token, selection?.action, amount].join(":"),
  );
  const submit = () =>
    run(async (assertCurrent) => {
      if (!wallet.account || !selection || !balance || !fresh)
        throw new Error("Wait for a fresh vault balance");
      const raw = vaultAmount(amount, selection.asset.decimals);
      await wallet.ensureNetwork();
      assertCurrent();
      const verified = verifiedVaultTransaction({
        action: selection.action,
        owner: wallet.account,
        mint: selection.asset.token,
        amount: raw,
        balance,
      });
      assertCurrent();
      const signature = await wallet.sendTransaction(verified.transaction);
      toast.add({
        type: "success",
        title: `${selection.action === "deposit" ? "Deposit" : "Withdrawal"} confirmed · ${signature.slice(0, 10)}…`,
        description: `Vault balances update after indexing. Minimum received: ${verified.received} ${selection.asset.symbol}.`,
      });
      onSuccess();
      void Promise.all([refresh(), refreshStores(["positions", "payout-credits"])]);
    });

  const maxAmount = () => {
    if (!selection || !balance) return "";
    const raw =
      selection.action === "deposit"
        ? BigInt(balance.canonicalBalance)
        : BigInt(balance.vaultAvailable);
    return formatTokenAmount(raw, selection.asset.decimals);
  };

  return { balance, busy, maxAmount, nativeLamports: null, needsNativeBalance: false, submit };
}
