import { percent } from "@/lib/markets/presentation";
export function ImpactBar({ value }: { value: number | null }) {
  const width = Math.min(Math.abs(value ?? 0) / 12, 1) * 50;
  return (
    <div className="relative my-3 h-[5px] rounded-sm bg-foreground/15">
      <span
        className={`absolute h-full rounded-sm ${(value ?? 0) < 0 ? "bg-danger" : "bg-positive"}`}
        style={{ width: `${width}%`, left: `${(value ?? 0) >= 0 ? 50 : 50 - width}%` }}
      />
      <span className="absolute -top-1 left-1/2 h-[13px] w-px bg-foreground" />
      <span
        className={`absolute -top-[21px] left-[calc(50%+8px)] whitespace-nowrap font-mono text-xs font-medium ${(value ?? 0) < 0 ? "text-danger" : "text-positive"}`}
      >
        {percent(value)}
      </span>
    </div>
  );
}
