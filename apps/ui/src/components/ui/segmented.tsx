"use client";
import { useLayoutEffect, useRef, useState } from "react";
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
  const groupRef = useRef<HTMLDivElement | null>(null);
  const [indicator, setIndicator] = useState<{ left: number; width: number } | null>(null);

  useLayoutEffect(() => {
    if (variant !== "category") {
      setIndicator(null);
      return;
    }
    const group = groupRef.current;
    if (!group) return;
    const update = () => {
      const items = group.querySelectorAll<HTMLElement>('[data-slot="toggle-group-item"]');
      const selected = [...items].find(
        (item) => item.dataset.option === value && item.getAttribute("aria-pressed") === "true",
      );
      if (items.length !== options.length || !selected) {
        setIndicator(null);
        return;
      }
      const groupBounds = group.getBoundingClientRect();
      const selectedBounds = selected.getBoundingClientRect();
      setIndicator({
        left: selectedBounds.left - groupBounds.left,
        width: selectedBounds.width,
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(group);
    for (const item of group.querySelectorAll('[data-slot="toggle-group-item"]'))
      observer.observe(item);
    window.addEventListener("resize", update);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", update);
    };
  }, [value, options.length, variant]);

  return (
    <ToggleGroup
      ref={groupRef}
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
        variant === "category" && "relative",
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
          data-option={option}
          className={cn("min-w-0", variant === "default" && "flex-1")}
        >
          {option}
        </ToggleGroupItem>
      ))}
      {variant === "category" && (
        <span
          aria-hidden="true"
          data-slot="segmented-indicator"
          className="pointer-events-none absolute -bottom-1.5 left-0 h-0.5 rounded-full bg-foreground transition-[transform,width] duration-300 ease-out motion-reduce:transition-none"
          style={{
            opacity: indicator ? 1 : 0,
            transform: `translate3d(${indicator?.left ?? 0}px, 0, 0)`,
            width: indicator?.width ?? 0,
          }}
        />
      )}
    </ToggleGroup>
  );
}
