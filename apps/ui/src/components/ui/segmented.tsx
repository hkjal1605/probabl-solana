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
  variant?: "default" | "category" | "compact";
}) {
  return (
    <ToggleGroup
      aria-label={label}
      disabled={disabled}
      variant={variant === "category" ? "category" : "default"}
      size={variant === "default" ? "default" : variant}
      spacing={variant === "category" ? 4 : 1}
      className={cn(
        variant === "default" ? "rounded-md border border-border p-0.5" : "border-0 p-0",
        className,
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
