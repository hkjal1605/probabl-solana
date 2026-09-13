export const short = (value: string, size = 4) =>
  value.length <= size * 2 + 2 ? value : `${value.slice(0, size + 2)}…${value.slice(-size)}`;
export const time = (value: string) =>
  new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
