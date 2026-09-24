/** Reads resolve locally, so there is no configured API origin to validate. */
export const API_URL = "";
export const apiUrl = (path: string) => {
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\"))
    throw new Error("Invalid API path");
  return path;
};
