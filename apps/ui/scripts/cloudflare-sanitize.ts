import { readFile, writeFile } from "node:fs/promises";

// OpenNext copies ALL monorepo .env* values into this module, including unrelated
// backend secrets. Never ship them: the UI's public settings are already inlined
// by Next, and server settings must come from Worker runtime bindings only.
export const sanitizedEnvironmentModule =
  "export const production = {};\nexport const development = {};\nexport const test = {};\n";

if (import.meta.main) {
  const directory = new URL("../.open-next/cloudflare/", import.meta.url);
  const init = await readFile(new URL("init.js", directory), "utf8");
  if (!init.includes('"./next-env.mjs"'))
    throw new Error("OpenNext env layout changed; review sanitization before deploying");
  await writeFile(new URL("next-env.mjs", directory), sanitizedEnvironmentModule, { mode: 0o600 });
  console.info("Removed all .env file values from the Worker environment module.");
}
