import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

/** Owns only the cluster created here. Existing localhost databases are never stopped. */
export async function localSolanaDatabase(existing?: string) {
  if (existing) {
    const url = new URL(existing);
    if (
      !["postgres:", "postgresql:"].includes(url.protocol) ||
      !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
    )
      throw new Error("The dev runner accepts only localhost PostgreSQL");
    return { connectionString: existing, close: async () => {} };
  }
  const directory = await mkdtemp(join(tmpdir(), "probabl-solana-dev-"));
  const data = join(directory, "postgres");
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port;
  await probe.stop(true);
  const command = (cmd: string, args: string[]) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(cmd, args, { stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(cmd + " exited " + code)),
      );
    });
  await command("initdb", ["-D", data, "-A", "trust", "-U", "probabl_dev"]);
  await command("pg_ctl", [
    "-D",
    data,
    "-l",
    join(directory, "postgres.log"),
    "-o",
    "-h 127.0.0.1 -p " + port + " -k " + directory,
    "start",
  ]);
  let closed = false;
  return {
    connectionString: "postgresql://probabl_dev@127.0.0.1:" + port + "/postgres",
    async close() {
      if (closed) return;
      await command("pg_ctl", ["-D", data, "-m", "fast", "stop"]);
      closed = true;
      console.info("Local database and logs remain recoverable at " + directory);
    },
  };
}
