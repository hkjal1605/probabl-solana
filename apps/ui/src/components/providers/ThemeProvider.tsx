"use client";

import { ThemeProvider as NextThemeProvider, useTheme } from "next-themes";
import { type ReactNode, useEffect, useState } from "react";

export function ThemeProvider({ children }: { children: ReactNode }) {
  return (
    <NextThemeProvider
      attribute="class"
      defaultTheme="system"
      enableSystem
      disableTransitionOnChange
      storageKey="probabl-theme"
    >
      <ThemeColor />
      {children}
    </NextThemeProvider>
  );
}

function ThemeColor() {
  const { resolvedTheme } = useTheme();
  const [color, setColor] = useState<string>();
  useEffect(() => {
    if (!resolvedTheme) return;
    // next-themes applies the root class in its parent effect. Read after it runs.
    const frame = requestAnimationFrame(() => {
      setColor(getComputedStyle(document.documentElement).getPropertyValue("--background").trim());
    });
    return () => cancelAnimationFrame(frame);
  }, [resolvedTheme]);
  return color ? <meta name="theme-color" content={color} /> : null;
}
