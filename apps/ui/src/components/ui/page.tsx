import type { ReactNode } from "react";
import { Alert, AlertAction, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription } from "@/components/ui/empty";
import { cn } from "@/lib/utils";

export function Page({
  children,
  className,
  variant = "content",
}: {
  children: ReactNode;
  className?: string;
  variant?: "content" | "terminal";
}) {
  return (
    <main
      data-layout={variant}
      className={cn(
        "mx-auto w-full min-w-0 flex-1",
        variant === "terminal" ? "px-3 py-3" : "max-w-[1056px] px-4 py-6",
        className,
      )}
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
    <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-2">
        <h1 className="scroll-m-20 text-2xl font-medium leading-7">{title}</h1>
        {description && (
          <div className="max-w-2xl text-sm leading-5 text-muted-foreground">{description}</div>
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
  variant = "default",
}: {
  label: string;
  value: ReactNode;
  className?: string;
  variant?: "default" | "market";
}) {
  if (variant === "market")
    return (
      <div className="flex shrink-0 flex-col gap-1">
        <div className="text-xs font-medium text-muted-foreground">{label}</div>
        <div className={cn("text-lg font-medium leading-4 tabular-nums", className)}>{value}</div>
      </div>
    );
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <div className={cn("text-lg font-normal leading-5 tabular-nums", className)}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
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
export function LoadingState() {
  return null;
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
