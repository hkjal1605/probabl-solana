"use client";
import { ArrowDown, ArrowUp, CornerDownLeft, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { LifecycleBadge } from "@/components/data/StatusBadge";
import { TokenIdentity } from "@/components/market/TokenIdentity";
import { Button } from "@/components/ui/button";
import {
  Combobox,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { InputGroupAddon } from "@/components/ui/input-group";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import type { MarketView } from "@/types/api";
import { useDebouncedSearch } from "../hooks/useDebouncedSearch";
import { normalizeSearch, searchMarkets } from "../utils/searchMarkets";

export function MarketSearchResults({
  markets,
  loading,
  error,
  retry,
  onSelect,
}: {
  markets: MarketView[];
  loading: boolean;
  error: boolean;
  retry: () => void;
  onSelect: (market: MarketView) => void;
}) {
  const [query, setQuery] = useState("");
  const debounced = useDebouncedSearch(query);
  const waiting = normalizeSearch(query) !== normalizeSearch(debounced);
  const result = useMemo(() => searchMarkets(markets, debounced), [markets, debounced]);
  // Never select an old result while a new query is waiting for its debounce.
  const items = waiting ? [] : result.items;
  return (
    <Combobox<MarketView>
      inline
      open
      autoHighlight
      items={items}
      filter={null}
      value={null}
      inputValue={query}
      onInputValueChange={setQuery}
      itemToStringLabel={(market) => `${market.ticker} · ${market.question}`}
      onValueChange={(market) => {
        if (market && !waiting) onSelect(market);
      }}
    >
      <ComboboxInput
        aria-label="Search markets"
        placeholder="Search event, token or address..."
        maxLength={200}
        showTrigger={false}
        showClear
        autoComplete="off"
        spellCheck={false}
      >
        <InputGroupAddon>
          <Search />
        </InputGroupAddon>
      </ComboboxInput>
      {error && (
        <div className="flex items-center justify-between gap-3 text-xs text-muted-foreground">
          <span>
            {markets.length
              ? "Showing cached markets. Updates are unavailable."
              : "Markets could not be loaded."}
          </span>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </div>
      )}
      <ComboboxList aria-label="Market results" className="min-h-40 max-h-[min(50dvh,400px)] p-0">
        <ComboboxGroup>
          {items.map((market) => (
            <ComboboxItem key={market.id} value={market} className="gap-3 px-3 py-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-3">
                  <TokenIdentity
                    symbol={market.ticker}
                    metadata={market.baseTokenMetadata}
                    showName={false}
                  />
                  <LifecycleBadge state={market.lifecycle} />
                </div>
                <p className="mt-2 line-clamp-2 text-sm leading-5">{market.question}</p>
                <p className="mt-1 truncate text-xs text-muted-foreground">
                  {market.baseTokenMetadata?.name ?? market.ticker} /{" "}
                  {market.quoteTokenMetadata?.symbol ?? market.quoteToken.slice(0, 8)}
                </p>
              </div>
            </ComboboxItem>
          ))}
        </ComboboxGroup>
        {!loading && !waiting && !items.length && !error && (
          <Empty className="min-h-40 py-3">
            <EmptyDescription>
              {query.trim()
                ? "No matching markets. Try another event, symbol or mint address."
                : "No markets are available yet."}
            </EmptyDescription>
          </Empty>
        )}
      </ComboboxList>
      <Separator />
      <div className="flex flex-wrap items-center gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <KbdGroup>
            <Kbd>
              <ArrowUp />
            </Kbd>
            <Kbd>
              <ArrowDown />
            </Kbd>
          </KbdGroup>{" "}
          Navigate
        </span>
        <span className="inline-flex items-center gap-1.5">
          <Kbd>
            <CornerDownLeft />
          </Kbd>{" "}
          Open
        </span>
        <span className="ml-auto inline-flex items-center gap-1.5">
          <Kbd>Esc</Kbd> Close
        </span>
      </div>
    </Combobox>
  );
}
