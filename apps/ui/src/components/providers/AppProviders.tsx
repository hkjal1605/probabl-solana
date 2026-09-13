"use client";

import { Toaster } from "@conditional-stocks/ui-kit/sonner";
import { ThemeProvider } from "@conditional-stocks/ui-kit/theme";
import { TooltipProvider } from "@conditional-stocks/ui-kit/tooltip";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { type ReactNode, useState } from "react";
import { UiStateProvider } from "./UiStateProvider";
import { WalletProvider } from "./WalletProvider";
import { readQueryDefaults } from "@/lib/api/read-policy";

export function AppProviders({ children }: { children: ReactNode }) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: { queries: readQueryDefaults },
      }),
  );
  return (
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <WalletProvider>
          <TooltipProvider delayDuration={250}>
            <UiStateProvider>{children}</UiStateProvider>
            <Toaster richColors position="bottom-right" />
          </TooltipProvider>
        </WalletProvider>
      </QueryClientProvider>
    </ThemeProvider>
  );
}
