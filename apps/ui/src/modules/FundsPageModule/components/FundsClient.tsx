"use client";
import { key } from "@conditional-stocks/solana-client";
import { ShieldOff } from "lucide-react";
import { useState } from "react";
import { useWallet } from "@/components/providers/WalletProvider";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Field, FieldGroup, FieldSet, FieldLabel as Label } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Item, ItemContent } from "@/components/ui/item";
import {
  LineTabsList as TabsList,
  LineTabsTrigger as TabsTrigger,
} from "@/components/ui/line-tabs";
import { DataError, EmptyState } from "@/components/ui/page";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import { toast } from "@/components/ui/toast";
import { protocolConfig } from "@/config/protocol";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useConfirmation } from "@/hooks/useConfirmation";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { shortAddress, tokenAmount } from "@/lib/format/display";
import { walletTransfer } from "@/lib/trading/funds";
import { solana } from "@/lib/trading/rpc";
import type { MarketView } from "@/types/api";

type FundsTab = "Deposit" | "Withdraw" | "Permissions";

export function FundsClient({ markets }: { markets: MarketView[] }) {
  const wallet = useWallet(),
    data = useWalletAssets(markets);
  const [tab, setTab] = useState<FundsTab>("Deposit"),
    [token, setToken] = useState(""),
    [recipient, setRecipient] = useState(""),
    [amount, setAmount] = useState("");
  const { busy, run } = useAsyncAction([wallet.account, token, recipient, amount].join(":"));
  const asset = data.assets.find((a) => a.token === token) ?? data.assets[0];
  const { confirm, confirmation } = useConfirmation(
    [wallet.account, token, recipient, amount].join(":"),
  );
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
        !(await confirm(
          `Issuer transfer fee: ${tokenAmount(fee.fee, asset.decimals)}. Recipient receives ${tokenAmount(fee.minimumReceived, asset.decimals)}. Continue?`,
        ))
      )
        return;
      assertCurrent();
      if (wallet.chainId !== protocolConfig.chainId) await wallet.ensureNetwork();
      assertCurrent();
      const hash = await wallet.sendTransaction(transaction);
      toast.add({
        type: "success",
        title: `Transfer submitted: ${hash.slice(0, 10)}… Balances update after indexing.`,
      });
      setAmount("");
    });
  const revoke = () =>
    run(async (assertCurrent) => {
      if (wallet.chainId !== protocolConfig.chainId) await wallet.ensureNetwork();
      if (!wallet.account || !asset) throw new Error("Select an asset and connect your wallet.");
      const owner = key(wallet.account),
        mint = key(asset.token);
      const transaction = await solana().revoke(owner, mint);
      assertCurrent();
      const hash = await wallet.sendTransaction(transaction);
      toast.add({ type: "success", title: `Revocation submitted: ${hash.slice(0, 10)}…` });
    });
  if (!wallet.account)
    return (
      <EmptyState>
        <p>Connect to manage wallet assets.</p>
        <Button variant="default" onClick={() => wallet.connect().catch(() => undefined)}>
          Connect wallet
        </Button>
        <p>Connecting does not grant spending permission.</p>
      </EmptyState>
    );
  return (
    <Card variant="panel" className="mx-auto max-w-[400px] border p-3">
      {confirmation}
      <Tabs
        value={tab}
        onValueChange={(value) => {
          if (value === "Deposit" || value === "Withdraw" || value === "Permissions") {
            setTab(value);
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
        <TabsContent value="Deposit" className="flex flex-col gap-3 pt-3">
          <p className="text-sm leading-6 text-muted-foreground">
            {`Send supported tokens on ${protocolConfig.chainName} directly to your wallet. Order funding is held in program vaults; available credits can be withdrawn from Portfolio.`}
          </p>
          <Item variant="outline">
            <ItemContent>
              <p className="eyebrow text-muted-foreground">Receiving address</p>
              <code className="block break-all text-xs leading-5">{wallet.account}</code>
            </ItemContent>
          </Item>
          <Button
            variant="outline"
            onClick={() =>
              navigator.clipboard
                .writeText(wallet.account ?? "")
                .then(() => toast.add({ type: "success", title: "Address copied" }))
                .catch(() => toast.add({ type: "error", title: "Clipboard is unavailable" }))
            }
          >
            Copy wallet address
          </Button>
          <div className="grid grid-cols-2 gap-3">
            {data.balances.map(({ token, symbol, balance }) => (
              <Item key={token} variant="outline">
                <ItemContent>
                  <p className="eyebrow text-muted-foreground">{symbol}</p>
                  <p className="tabular-nums">
                    {tokenAmount(balance.canonicalBalance, balance.decimals).toLocaleString(
                      "en-US",
                      {
                        maximumFractionDigits: 4,
                      },
                    )}
                  </p>
                </ItemContent>
              </Item>
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
        <TabsContent value="Withdraw" className="flex flex-col gap-3 pt-3">
          <FieldSet disabled={busy} className="flex flex-col gap-4">
            <FieldGroup>
              <Field>
                <Label htmlFor="funds-token">Asset</Label>
                <Select
                  items={data.assets.map((a) => ({ value: a.token, label: a.symbol }))}
                  value={asset?.token ?? ""}
                  disabled={busy}
                  onValueChange={(value) => {
                    if (value !== null) setToken(value);
                  }}
                >
                  <SelectTrigger id="funds-token" className="w-full">
                    <SelectValue placeholder="Choose a supported asset" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectGroup>
                      {data.assets.map((a) => (
                        <SelectItem key={a.token} value={a.token}>
                          {a.symbol} · {shortAddress(a.token)}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <Label htmlFor="funds-recipient">Receiving address</Label>
                <Input
                  id="funds-recipient"
                  className="font-mono"
                  value={recipient}
                  onChange={(e) => setRecipient(e.target.value)}
                  placeholder="Solana address"
                />
              </Field>
              <Field>
                <Label htmlFor="funds-amount">Amount ({asset?.symbol ?? "tokens"})</Label>
                <Input
                  id="funds-amount"
                  className="tabular-nums"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="0.00"
                />
              </Field>
              <p className="text-xs leading-5 text-muted-foreground">
                This is a wallet transfer. Verify the receiving address and network; confirmed
                transfers cannot be reversed. Network gas applies.
              </p>
              <Button
                className="w-full"
                variant="default"
                onClick={transfer}
                disabled={busy || !asset || !amount || !recipient}
              >
                {busy && <Spinner data-icon="inline-start" />}
                Review in wallet
              </Button>
            </FieldGroup>
          </FieldSet>
        </TabsContent>
        <TabsContent value="Permissions" className="flex flex-col gap-3 pt-3">
          <Select
            value={asset?.token ?? ""}
            items={data.assets.map((a) => ({ value: a.token, label: a.symbol }))}
            onValueChange={(value) => {
              if (value !== null) setToken(value);
            }}
            disabled={busy}
          >
            <SelectTrigger aria-label="Permission asset" className="w-full">
              <SelectValue placeholder="Asset" />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {data.assets.map((a) => (
                  <SelectItem key={a.token} value={a.token}>
                    {a.symbol}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
          <p className="text-sm leading-6 text-muted-foreground">
            The app uses exact transfers without persistent delegates. You can revoke a delegate
            granted elsewhere. Existing escrowed orders must be cancelled separately.
          </p>
          {([["token", `${asset?.symbol ?? "Token"} SPL delegate`]] as const).map(
            ([kind, label]) => (
              <Item key={kind} variant="outline">
                <ItemContent>
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
                </ItemContent>
              </Item>
            ),
          )}
        </TabsContent>
      </Tabs>
    </Card>
  );
}
