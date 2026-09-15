"use client";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
  disabled = false,
  variant = "default",
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
  variant?: "default" | "category" | "compact" | "timeframe" | "chart" | "trade";
}) {
  return (
    <ToggleGroup
      aria-label={label}
      disabled={disabled}
      variant={
        variant === "category" || variant === "timeframe" || variant === "chart"
          ? variant
          : "default"
      }
      size={variant === "default" || variant === "trade" ? "default" : variant}
      spacing={variant === "category" ? 4 : variant === "timeframe" ? 0.5 : 1}
      className={cn(
        variant === "chart"
          ? "rounded-xl border border-border p-[3px]"
          : variant === "default"
            ? "rounded-md border border-border p-0.5"
            : "border-0 p-0",
        className,
        variant === "trade" && "trade-side-selector",
      )}
      value={[value]}
      onValueChange={(next) => {
        const option = options.find((item) => item === next[0]);
        if (option !== undefined) onChange(option);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option}
          value={option}
          className={cn("min-w-0", variant === "default" && "flex-1")}
        >
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
