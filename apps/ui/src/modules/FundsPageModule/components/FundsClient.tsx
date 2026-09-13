"use client";
import { Button } from "@conditional-stocks/ui-kit/button";
import { Input } from "@conditional-stocks/ui-kit/input";
import { Label } from "@conditional-stocks/ui-kit/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@conditional-stocks/ui-kit/select";
import { Tabs, TabsContent } from "@conditional-stocks/ui-kit/tabs";
import { LoaderCircle, ShieldOff } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { key } from "@conditional-stocks/solana-client";
import { useUiStore } from "@/components/providers/UiStateProvider";
import { useWallet } from "@/components/providers/WalletProvider";
import {
  LineTabsList as TabsList,
  LineTabsTrigger as TabsTrigger,
} from "@/components/ui/line-tabs";
import { DataError, EmptyState } from "@/components/ui/page";
import { protocolConfig } from "@/config/protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import type { MarketView } from "@/lib/api/types";
import { shortAddress, tokenAmount } from "@/lib/format/display";
import { walletTransfer } from "@/lib/trading/funds";
import { solana } from "@/lib/trading/rpc";
import type { FundsTab } from "@/stores/ui-store";

export function FundsClient({
  markets,
  embedded = false,
}: {
  markets: MarketView[];
  embedded?: boolean;
}) {
  const wallet = useWallet(),
    data = useWalletAssets(markets);
  const modalTab = useUiStore((s) => s.funds),
    setFunds = useUiStore((s) => s.setFunds);
  const [tab, setTab] = useState<FundsTab>("Deposit"),
    [token, setToken] = useState(""),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState("");
  const { busy, run } = useAsyncAction(
    [wallet.account, token, recipient, amount].join(":"),
  );
  const asset = data.assets.find((a) => a.token === token) ?? data.assets[0];
  const currentTab = embedded ? (modalTab ?? "Deposit") : tab;
  const transfer = () =>
    run(async (assertCurrent) => {
      if (!asset || !wallet.account) return;
      const transaction = await walletTransfer({
        account: wallet.account,
        token: asset.token,
        recipient,
        amount,
        decimals: asset.decimals,
      });
      assertCurrent();
      const fee = transaction.issuerTransfers?.[0];
      if (
        fee &&
        BigInt(fee.fee) > 0n &&
        !window.confirm(
          `Issuer transfer fee: ${tokenAmount(fee.fee, asset.decimals)}. Recipient receives ${tokenAmount(fee.minimumReceived, asset.decimals)}. Continue?`,
        )
      )
        return;
      if (wallet.chainId !== protocolConfig.chainId)
        await wallet.ensureNetwork();
      assertCurrent();
      const hash = await wallet.sendTransaction(transaction);
      toast.success(
        `Transfer submitted: ${hash.slice(0, 10)}… Balances update after indexing.`,
      );
      setAmount("");
    });
  const revoke = () =>
    run(async (assertCurrent) => {
      if (wallet.chainId !== protocolConfig.chainId)
        await wallet.ensureNetwork();
      if (!wallet.account || !asset)
        throw new Error("Select an asset and connect your wallet.");
      const owner = key(wallet.account),
        mint = key(asset.token);
      const transaction = await solana().revoke(owner, mint);
      assertCurrent();
      const hash = await wallet.sendTransaction(transaction);
      toast.success(`Revocation submitted: ${hash.slice(0, 10)}…`);
    });
  if (!wallet.account)
    return (
      <EmptyState>
        <p>Connect to manage wallet assets.</p>
        <Button
          variant="brand"
          onClick={() => wallet.connect().catch(() => undefined)}
        >
          Connect wallet
        </Button>
        <p>Connecting does not grant spending permission.</p>
      </EmptyState>
    );
  return (
    <div className={embedded ? "min-w-0" : "panel mx-auto max-w-2xl p-5"}>
      <Tabs
        value={currentTab}
        onValueChange={(value) => {
          if (
            value === "Deposit" ||
            value === "Withdraw" ||
            value === "Permissions"
          ) {
            if (embedded) setFunds(value);
            else setTab(value);
          }
        }}
      >
        <TabsList aria-label="Funds action">
          {["Deposit", "Withdraw", "Permissions"].map((value) => (
            <TabsTrigger key={value} value={value}>
              {value}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value="Deposit" className="space-y-5 pt-4">
          <p className="text-sm leading-6 text-muted-foreground">
            {`Send supported tokens on ${protocolConfig.chainName} directly to your wallet. Order funding is held in program vaults; available credits can be withdrawn from Portfolio.`}
          </p>
          <div className="rounded-lg border bg-secondary p-4">
            <p className="eyebrow text-muted-foreground">Receiving address</p>
            <code className="mt-3 block break-all text-xs">
              {wallet.account}
            </code>
          </div>
          <Button
            variant="outline"
            onClick={() =>
              navigator.clipboard
                .writeText(wallet.account ?? "")
                .then(() => toast.success("Address copied"))
                .catch(() => toast.error("Clipboard is unavailable"))
            }
          >
            Copy wallet address
          </Button>
          <div className="grid grid-cols-2 gap-3">
            {data.balances.map(({ token, symbol, balance }) => (
              <div key={token} className="rounded-lg border p-3">
                <p className="eyebrow text-muted-foreground">{symbol}</p>
                <p className="mt-2 font-mono">
                  {tokenAmount(
                    balance.canonicalBalance,
                    balance.decimals,
                  ).toLocaleString("en-US", {
                    maximumFractionDigits: 4,
                  })}
                </p>
              </div>
            ))}
          </div>
          {data.isError && (
            <DataError
              retry={() => {
                void data.refetch();
              }}
              message="Canonical balances are unavailable."
            />
          )}
        </TabsContent>
        <TabsContent value="Withdraw" className="space-y-4 pt-4">
          <fieldset disabled={busy} className="space-y-4">
            <div>
              <Label htmlFor="funds-token">Asset</Label>
              <Select value={asset?.token ?? ""} onValueChange={setToken}>
                <SelectTrigger id="funds-token" className="mt-2 w-full">
                  <SelectValue placeholder="Choose a supported asset" />
                </SelectTrigger>
                <SelectContent>
                  {data.assets.map((a) => (
                    <SelectItem key={a.token} value={a.token}>
                      {a.symbol} · {shortAddress(a.token)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="funds-recipient">Receiving address</Label>
              <Input
                id="funds-recipient"
                className="mt-2 font-mono"
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                placeholder="Solana address"
              />
            </div>
            <div>
              <Label htmlFor="funds-amount">
                Amount ({asset?.symbol ?? "tokens"})
              </Label>
              <Input
                id="funds-amount"
                className="mt-2 font-mono"
                inputMode="decimal"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <p className="text-xs leading-5 text-muted-foreground">
              This is a wallet transfer. Verify the receiving address and
              network; confirmed transfers cannot be reversed. Network gas
              applies.
            </p>
            <Button
              className="w-full"
              variant="brand"
              onClick={transfer}
              disabled={busy || !asset || !amount || !recipient}
            >
              {busy && <LoaderCircle className="animate-spin" />}
              Review in wallet
            </Button>
          </fieldset>
        </TabsContent>
        <TabsContent value="Permissions" className="space-y-4 pt-4">
          <Select
            value={asset?.token ?? ""}
            onValueChange={setToken}
            disabled={busy}
          >
            <SelectTrigger aria-label="Permission asset" className="w-full">
              <SelectValue placeholder="Asset" />
            </SelectTrigger>
            <SelectContent>
              {data.assets.map((a) => (
                <SelectItem key={a.token} value={a.token}>
                  {a.symbol}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-sm leading-6 text-muted-foreground">
            The app uses exact transfers without persistent delegates. You can
            revoke a delegate granted elsewhere. Existing escrowed orders must
            be cancelled separately.
          </p>
          {(
            [["token", `${asset?.symbol ?? "Token"} SPL delegate`]] as const
          ).map(([kind, label]) => (
            <div
              key={kind}
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3"
            >
              <span className="text-sm font-medium">{label}</span>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy || (kind === "token" && !asset)}
                onClick={revoke}
              >
                <ShieldOff />
                Revoke
              </Button>
            </div>
          ))}
        </TabsContent>
      </Tabs>
    </div>
  );
}
