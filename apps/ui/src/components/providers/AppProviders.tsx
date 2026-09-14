"use client";

import { Toaster } from "@conditional-stocks/ui-kit/sonner";
import { ThemeProvider } from "@conditional-stocks/ui-kit/theme";
import { TooltipProvider } from "@conditional-stocks/ui-kit/tooltip";
import { type ReactNode } from "react";
import { UiStateProvider } from "./UiStateProvider";
import { WalletProvider } from "./WalletProvider";
import { IndexStreamProvider } from "./IndexStreamProvider";

export function AppProviders({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider>
        <WalletProvider>
          <TooltipProvider delayDuration={250}>
            <IndexStreamProvider><UiStateProvider>{children}</UiStateProvider></IndexStreamProvider>
            <Toaster richColors position="bottom-right" />
          </TooltipProvider>
        </WalletProvider>
    </ThemeProvider>
  );
}
