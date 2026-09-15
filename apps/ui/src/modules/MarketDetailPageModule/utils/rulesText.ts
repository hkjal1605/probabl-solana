export function safeRulesLink(value: string): string | null {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/** Keep the saved text intact. Only turn explicit HTTP(S) URLs into links. */
export function rulesTextParts(text: string) {
  const parts: Array<{ text: string; href: string | null; offset: number }> = [];
  let offset = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const start = match.index;
    if (start > offset) parts.push({ text: text.slice(offset, start), href: null, offset });
    let candidate = match[0].replace(/[.,;!?:]+$/, "");
    for (const [open, close] of [
      ["(", ")"],
      ["[", "]"],
      ["{", "}"],
    ] as const) {
      while (
        candidate.endsWith(close) &&
        candidate.split(close).length > candidate.split(open).length
      )
        candidate = candidate.slice(0, -1);
    }
    parts.push({ text: candidate, href: safeRulesLink(candidate), offset: start });
    offset = start + candidate.length;
  }
  if (offset < text.length) parts.push({ text: text.slice(offset), href: null, offset });
  return parts;
}
