"use client";

import type { ReactElement, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";

/** Non-button help text remains focusable for keyboard and touch users. */
export function InfoTooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  if (!content) return children;
  return (
    <Tooltip>
      <TooltipTrigger
        render={children}
        tabIndex={0}
        aria-description={typeof content === "string" ? content : undefined}
      />
      <TooltipContent>{content}</TooltipContent>
    </Tooltip>
  );
}
