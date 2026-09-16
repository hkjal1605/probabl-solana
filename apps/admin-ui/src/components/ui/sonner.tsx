"use client";

import { useTheme } from "next-themes";
import type * as React from "react";
import { Toaster as Sonner } from "sonner";

function Toaster({ style, ...props }: React.ComponentProps<typeof Sonner>) {
  const { resolvedTheme } = useTheme();
  return (
    <Sonner
      theme={resolvedTheme === "dark" ? "dark" : "light"}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--success-bg": "var(--positive-soft)",
          "--success-text": "var(--positive)",
          "--success-border": "var(--positive)",
          "--info-bg": "var(--info-soft)",
          "--info-text": "var(--info)",
          "--info-border": "var(--info)",
          "--warning-bg": "var(--warning-soft)",
          "--warning-text": "var(--warning)",
          "--warning-border": "var(--warning)",
          "--error-bg": "var(--danger-soft)",
          "--error-text": "var(--danger)",
          "--error-border": "var(--danger)",
          ...style,
        } as React.CSSProperties
      }
      toastOptions={{
        classNames: {
          toast: "shadow-lg",
          description: "!text-inherit",
        },
      }}
      {...props}
    />
  );
}

export { Toaster };
