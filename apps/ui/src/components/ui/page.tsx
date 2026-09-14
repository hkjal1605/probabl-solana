import type { ReactNode } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";

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
        <h1 className="scroll-m-20 text-3xl font-semibold tracking-tight">{title}</h1>
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
    <Empty className="min-h-40">
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
  );
}
export function LoadingState({ children = "Loading…" }: { children?: ReactNode }) {
  return (
    <Empty className="min-h-40" role="status" aria-busy="true">
      <Spinner />
      <EmptyDescription>{children}</EmptyDescription>
    </Empty>
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
    <Alert variant="destructive" className="my-4">
      <AlertDescription>{message}</AlertDescription>
      {retry && (
        <AlertAction>
          <Button variant="outline" size="sm" onClick={retry}>
            Retry
          </Button>
        </AlertAction>
      )}
    </Alert>
  );
}
