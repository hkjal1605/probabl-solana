"use client";

import type { ReactNode } from "react";
import { Toaster } from "@/components/ui/toast";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WalletLoginProvider } from "@/components/wallet/WalletLoginProvider";
import { IndexStreamProvider } from "./IndexStreamProvider";
import { ThemeProvider } from "./ThemeProvider";
import { UiStateProvider } from "./UiStateProvider";
import { WalletProvider } from "./WalletProvider";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
      <WalletProvider>
        <TooltipProvider delay={250}>
          <WalletLoginProvider>
            <IndexStreamProvider>
              <UiStateProvider>{children}</UiStateProvider>
            </IndexStreamProvider>
          </WalletLoginProvider>
          <Toaster />
        </TooltipProvider>
      </WalletProvider>
    </ThemeProvider>
  );
}
