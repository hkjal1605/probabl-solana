"use client";
import { TabsList, TabsTrigger } from "@conditional-stocks/ui-kit/tabs";
import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

export function LineTabsList({ className, ...props }: ComponentProps<typeof TabsList>) {
  return (
    <TabsList
      className={cn(
        "h-auto w-full justify-start gap-5 overflow-x-auto rounded-none border-b bg-transparent px-[18px] py-0",
        className,
      )}
      {...props}
    />
  );
}
export function LineTabsTrigger({ className, ...props }: ComponentProps<typeof TabsTrigger>) {
  return (
    <TabsTrigger
      className={cn(
        "h-12 flex-none rounded-none border-0 border-b-2 border-transparent bg-transparent px-0 text-sm font-medium shadow-none data-[state=active]:border-foreground data-[state=active]:bg-transparent data-[state=active]:text-foreground data-[state=active]:shadow-none",
        className,
      )}
      {...props}
    />
  );
}
