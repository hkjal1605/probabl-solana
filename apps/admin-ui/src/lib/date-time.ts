const LAST_DISPLAYABLE_SECOND = 253402300799n; // 9999-12-31T23:59:59Z

/** datetime-local has no timezone. Our labelled UTC inputs always represent UTC. */
export function unixSecondsToDateTimeInput(value: string): string {
  if (!/^(0|[1-9][0-9]{0,11})$/.test(value) || BigInt(value) > LAST_DISPLAYABLE_SECOND)
    throw new Error("Timestamp must be between 1970 and 9999 for the date/time editor.");
  return new Date(Number(value) * 1000).toISOString().slice(0, 19);
}

/** Convert only complete, real calendar dates; never silently roll February 30 into March. */
export function dateTimeInputToUnixSeconds(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))
    throw new Error("Enter a complete UTC date and time.");
  const normalized = value.length === 16 ? `${value}:00` : value;
  const milliseconds = Date.parse(`${normalized}Z`);
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    new Date(milliseconds).toISOString().slice(0, 19) !== normalized
  )
    throw new Error("Enter a valid UTC date and time between 1970 and 9999.");
  return String(milliseconds / 1000);
}
