import { Button } from "@conditional-stocks/ui-kit/button";
import { cn } from "@conditional-stocks/ui-kit/utils";
import type { ReactNode } from "react";

export function Page({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <main
      className={cn("mx-auto w-full max-w-[1440px] flex-1 px-5 py-8 sm:px-8 lg:py-10", className)}
    >
      {children}
    </main>
  );
}
export function PageHeading({
  title,
  description,
  children,
}: {
  title: string;
  description?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-6">
      <div>
        <h1 className="text-[32px] font-semibold leading-tight tracking-[-0.045em]">{title}</h1>
        {description && (
          <div className="mt-3 max-w-3xl text-sm font-medium leading-6 text-muted-foreground">
            {description}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}
export function Stat({
  label,
  value,
  className,
}: {
  label: string;
  value: ReactNode;
  className?: string;
}) {
  return (
    <div className="min-w-0">
      <div className={cn("font-mono text-xl font-medium leading-tight", className)}>{value}</div>
      <div className="mt-2 text-xs font-medium text-muted-foreground">{label}</div>
    </div>
  );
}
export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="grid min-h-40 place-content-center gap-3 p-8 text-center text-sm font-medium leading-6 text-muted-foreground">
      {children}
    </div>
  );
}
export function DataError({
  retry,
  message = "Data is temporarily unavailable.",
}: {
  retry?: () => void;
  message?: string;
}) {
  return (
    <div
      role="alert"
      className="my-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-danger/30 bg-danger-soft px-4 py-3 text-sm text-danger"
    >
      <span>{message}</span>
      {retry && (
        <Button variant="outline" size="sm" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}
