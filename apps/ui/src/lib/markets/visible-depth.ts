/** Number of price rows that fit above and below the midpoint without scrolling. */
export function visibleDepthPerSide(
  availableHeight: number,
  headerHeight: number,
  rowHeight: number,
): number {
  if (
    !Number.isFinite(availableHeight) ||
    !Number.isFinite(headerHeight) ||
    !Number.isFinite(rowHeight) ||
    availableHeight <= 0 ||
    headerHeight < 0 ||
    rowHeight <= 0
  )
    return 1;
  return Math.max(1, Math.floor((availableHeight - headerHeight - rowHeight) / (2 * rowHeight)));
}
