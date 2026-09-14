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
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <ToggleGroup
      aria-label={label}
      disabled={disabled}
      variant="outline"
      className={cn(className)}
      value={[value]}
      onValueChange={(next) => {
        const option = options.find((item) => item === next[0]);
        if (option !== undefined) onChange(option);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem key={option} value={option}>
          {option}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
