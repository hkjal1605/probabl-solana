"use client";
import { Tabs, TabsList, TabsTrigger } from "@conditional-stocks/ui-kit/tabs";
import { cn } from "@/lib/utils";
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: readonly T[];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <Tabs
      value={value}
      onValueChange={(next) => {
        const option = options.find((item) => item === next);
        if (option !== undefined) onChange(option);
      }}
    >
      <TabsList aria-label={label} className={cn("h-9 rounded-lg", className)}>
        {options.map((option) => (
          <TabsTrigger key={option} value={option} className="h-7 rounded-md text-xs">
            {option}
          </TabsTrigger>
        ))}
      </TabsList>
    </Tabs>
  );
}
