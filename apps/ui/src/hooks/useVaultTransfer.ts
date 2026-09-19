"use client";

import { formatTokenAmount } from "@conditional-stocks/domain";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { useEffect, useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { toast } from "@/components/ui/toast";
import type { WalletAsset, WalletAssetBalance } from "@/hooks/useWalletAssets";
import { solana } from "@/lib/trading/rpc";
import { type VaultQuote, vaultAmount, verifiedVaultTransaction } from "@/lib/trading/vault";
import { api } from "@/services/protocol-api-service";
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
  loadNativeBalance = false,
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
  const [nativeSnapshot, setNativeSnapshot] = useState<{ owner: string; lamports: bigint } | null>(
    null,
  );
  const needsNativeBalance =
    selection?.action === "deposit" && selection.asset.token === String(NATIVE_MINT);

  useEffect(() => {
    if ((!needsNativeBalance && !loadNativeBalance) || !wallet.account) return;
    let active = true;
    const owner = wallet.account;
    solana()
      .connection.getBalance(new PublicKey(owner), "confirmed")
      .then((value) => {
        if (active) setNativeSnapshot({ owner, lamports: BigInt(value) });
      })
      .catch(() => {
        if (active) setNativeSnapshot(null);
      });
    return () => {
      active = false;
    };
  }, [loadNativeBalance, needsNativeBalance, wallet.account]);

  const nativeLamports = nativeSnapshot?.owner === wallet.account ? nativeSnapshot.lamports : null;
  const balance = balances.find((row) => row.token === selection?.asset.token)?.balance;
  const { busy, run } = useAsyncAction(
    [wallet.account, selection?.asset.token, selection?.action, amount].join(":"),
  );
  const submit = () =>
    run(async (assertCurrent) => {
      if (!wallet.account || !selection || !balance || !fresh)
        throw new Error("Wait for a fresh vault balance");
      const owner = wallet.account;
      const raw = vaultAmount(amount, selection.asset.decimals);
      await wallet.ensureNetwork();
      assertCurrent();
      const token = wallet.sessionToken ?? (await wallet.authenticate());
      assertCurrent();
      const quote = await api.prepare<VaultQuote>(
        `vault/${selection.action}/prepare`,
        {
          scope: "global",
          asset: selection.asset.token,
          amount: String(raw),
        },
        token,
      );
      assertCurrent();
      const confirmedNativeLamports = needsNativeBalance
        ? BigInt(await solana().connection.getBalance(new PublicKey(owner), "confirmed"))
        : undefined;
      const verified = verifiedVaultTransaction({
        action: selection.action,
        owner,
        mint: selection.asset.token,
        amount: raw,
        balance,
        quote,
        ...(confirmedNativeLamports === undefined
          ? {}
          : { nativeLamports: confirmedNativeLamports }),
      });
      assertCurrent();
      const signature = await wallet.sendTransaction(verified.transaction);
      if (selection.asset.token === String(NATIVE_MINT)) {
        void solana()
          .connection.getBalance(new PublicKey(owner), "confirmed")
          .then((value) => setNativeSnapshot({ owner, lamports: BigInt(value) }))
          .catch(() => setNativeSnapshot(null));
      }
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
    let raw =
      selection.action === "deposit"
        ? BigInt(balance.canonicalBalance)
        : BigInt(balance.vaultAvailable);
    if (needsNativeBalance && nativeLamports !== null)
      raw += nativeLamports > 20_000_000n ? nativeLamports - 20_000_000n : 0n;
    return formatTokenAmount(raw, selection.asset.decimals);
  };

  return { balance, busy, maxAmount, nativeLamports, needsNativeBalance, submit };
}
