/** Keep layout stable and last-known rows visible during background failures. */
export function RefreshStatus({ active, label = "data" }: { active: boolean; label?: string }) {
  return (
    <div
      className="min-h-4 px-3 text-xs leading-4 text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      {active ? `Reconnecting… Showing last-known ${label}.` : null}
    </div>
  );
}
