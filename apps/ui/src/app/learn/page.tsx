import { Button } from "@conditional-stocks/ui-kit/button";
import Link from "next/link";
import { Page } from "@/components/ui/page";
export default function LearnPage() {
  return (
    <Page className="max-w-[840px] py-14">
      <div className="eyebrow text-positive">
        A DIFFERENT WAY TO LOOK AT EVENTS
      </div>
      <h1 className="mt-5 text-4xl font-semibold leading-tight tracking-[-0.055em] sm:text-[56px]">
        Price the impact.
        <br />
        Trade the outcome.
      </h1>
      <p className="mt-6 text-base leading-8 text-muted-foreground">
        Explore conditional stock markets funded with USDG and tokenized stocks.
        Each branch represents a different outcome.
      </p>
      <div className="my-12 space-y-10 text-sm font-medium leading-7 text-muted-foreground">
        <section>
          <h2 className="mb-3 text-xl font-semibold text-foreground">
            01 / Two worlds. Two order books.
          </h2>
          <p>
            Each event has a YES stock book and a NO stock book. Their prices
            represent the asset inside those different outcomes. Impact compares
            their midpoints, relative to the NO price. Polymarket probability is
            an informational reference, not the stock’s execution price or the
            local settlement authority.
          </p>
        </section>
        <section>
          <h2 className="mb-3 text-xl font-semibold text-foreground">
            02 / Whole tokens or active claims.
          </h2>
          <p>
            Buy YES stock with whole USDG and a fill gives you YES stock claims
            plus complementary NO cash claims. Sell with whole stock and you
            receive cash claims plus complementary stock claims. Funding with an
            existing active claim does not mint an extra complementary claim.
            Maker and taker fees, if enabled, are deducted from received claims
            and must fit your signed fee cap.
          </p>
        </section>
        <section>
          <h2 className="mb-3 text-xl font-semibold text-foreground">
            03 / Control your execution.
          </h2>
          <p>
            The API finds candidate matches. You review, sign, and submit one
            atomic place-and-match transaction; the contract verifies and
            settles it. A GTC limit order can rest until filled, cancelled,
            expired, or cutoff. IOC fills available depth within your limit and
            releases the remainder. Market mode is a price-bounded IOC with a 1%
            worst-price limit. Changed liquidity can require a fresh review.
            Reservations are not available for another action.
          </p>
        </section>
        <section>
          <h2 className="mb-3 text-xl font-semibold text-foreground">
            04 / Split, merge, and redeem.
          </h2>
          <p>
            Split one whole token into one YES and one NO claim. Merge an equal
            pair to restore the whole token. After resolution, winning claims
            return collateral, losing claims burn for zero, and an invalid 50/50
            outcome pays half per branch. Recovery combines claims and retains
            any unmatched raw claim so fractional value is not burned. Always
            review the finalized payout before redeeming. Rejected transfers
            remain claimable from the payout vault.
          </p>
        </section>
        <section>
          <h2 className="mb-3 text-xl font-semibold text-foreground">
            05 / Your wallet, your control.
          </h2>
          <p>
            Connecting a wallet does not move funds. Exact vault funding and
            transactions require your explicit confirmation on the configured
            network. Local admins resolve markets using explicitly reviewed
            evidence. Do not treat an indicative chart, a probability, or an
            estimated mark as a guaranteed return.
          </p>
          <p className="mt-3">
            Market creation and resolution require authorized administrators.
            This app displays indexed state and never simulates transactions or
            payouts.
          </p>
        </section>
      </div>
      <Button asChild variant="brand" size="lg">
        <Link href="/markets">Explore markets →</Link>
      </Button>
    </Page>
  );
}
