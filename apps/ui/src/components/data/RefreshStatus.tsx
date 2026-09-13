/** Keep layout stable and last-known rows visible during background failures. */
export function RefreshStatus({ active, label = "data" }: { active: boolean; label?: string }) {
  return (
    <div
      className="min-h-6 px-4 py-1 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      {active ? `Reconnecting… Showing last-known ${label}.` : null}
    </div>
  );
}
