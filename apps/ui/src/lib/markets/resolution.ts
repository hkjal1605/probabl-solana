import type { ResolutionView } from "@/lib/api/types";
export function outcomeLabel(resolution: ResolutionView | null) {
  try {
    if (!resolution?.yesPayout || !resolution.noPayout || !resolution.payoutDenominator)
      return "Pending";
    const yes = BigInt(resolution.yesPayout),
      no = BigInt(resolution.noPayout),
      denominator = BigInt(resolution.payoutDenominator);
    if (denominator <= 0n || yes < 0n || no < 0n || yes + no !== denominator)
      return "Unverified payout";
    if (yes === denominator) return "YES";
    if (no === denominator) return "NO";
    if (yes === no) return "Invalid · 50/50";
    return "Split payout";
  } catch {
    return "Unverified payout";
  }
}
/** Evidence is untrusted metadata; never expose javascript: or other executable URLs. */
export function safeExternalUrl(value: string | null | undefined): string | null {
  try {
    const url = new URL(value ?? "");
    return url.protocol === "https:" && !url.username && !url.password ? url.href : null;
  } catch {
    return null;
  }
}
