"use client";

import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { IndexStreamProvider } from "./IndexStreamProvider";
import { ThemeProvider } from "./ThemeProvider";
import { UiStateProvider } from "./UiStateProvider";
import { WalletProvider } from "./WalletProvider";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <WalletProvider>
        <TooltipProvider delay={250}>
          <IndexStreamProvider>
            <UiStateProvider>{children}</UiStateProvider>
          </IndexStreamProvider>
          <Toaster />
        </TooltipProvider>
      </WalletProvider>
    </ThemeProvider>
  );
}
