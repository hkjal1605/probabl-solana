"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { ThemeProvider as NextThemeProvider, useTheme } from "next-themes";
import { type ReactNode, useEffect, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger } from "./select.tsx";

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

export function ThemeSelect() {
  const { theme, setTheme } = useTheme();
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const selected = mounted ? (theme ?? "system") : "system";
  const Icon = selected === "light" ? Sun : selected === "dark" ? Moon : Monitor;
  return (
    <Select value={selected} onValueChange={setTheme}>
      <SelectTrigger
        aria-label={`Color theme: ${selected}`}
        title="Color theme"
        size="sm"
        disabled={!mounted}
        className="size-8 justify-center border-transparent px-0 hover:bg-muted [&>svg:last-child]:hidden"
      >
        <Icon aria-hidden="true" />
        <span className="sr-only">Color theme: {selected}</span>
      </SelectTrigger>
      <SelectContent align="end">
        <SelectItem value="light">
          <span className="flex items-center gap-2">
            <Sun className="size-4" aria-hidden="true" /> Light
          </span>
        </SelectItem>
        <SelectItem value="dark">
          <span className="flex items-center gap-2">
            <Moon className="size-4" aria-hidden="true" /> Dark
          </span>
        </SelectItem>
        <SelectItem value="system">
          <span className="flex items-center gap-2">
            <Monitor className="size-4" aria-hidden="true" /> System
          </span>
        </SelectItem>
      </SelectContent>
    </Select>
  );
}
