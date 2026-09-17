import { readFile, writeFile } from "node:fs/promises";

// OpenNext copies monorepo .env* values into this generated module. Remove
// them before deployment: public Next values are already compiled into the
// client bundle, while server settings come from Worker runtime bindings.
const sanitizedEnvironmentModule =
  "export const production = {};\nexport const development = {};\nexport const test = {};\n";

const directory = new URL("../.open-next/cloudflare/", import.meta.url);
const init = await readFile(new URL("init.js", directory), "utf8");
if (!init.includes('"./next-env.mjs"'))
  throw new Error("OpenNext env layout changed; review sanitization before deploying");
await writeFile(new URL("next-env.mjs", directory), sanitizedEnvironmentModule, { mode: 0o600 });
console.info("Removed all .env file values from the admin Worker environment module.");
