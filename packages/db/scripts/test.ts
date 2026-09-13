import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
let child: ChildProcess | undefined;
let interrupted: NodeJS.Signals | undefined;
let cleaning = false;
const interrupt = (signal: NodeJS.Signals) => {
  interrupted = signal;
  if (!cleaning) child?.kill(signal);
};
const onTerm = () => interrupt("SIGTERM");
const onInt = () => interrupt("SIGINT");
process.on("SIGTERM", onTerm);
process.on("SIGINT", onInt);
const run = (command: string, parameters: string[], environment = process.env) =>
  new Promise<number>((resolve, reject) => {
    if (interrupted && !cleaning) {
      resolve(1);
      return;
    }
    child = spawn(command, parameters, { env: environment, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => {
      child = undefined;
      resolve(code ?? 1);
    });
  });

try {
  if (process.env.TEST_DATABASE_URL) {
    process.exitCode = await run("bun", ["--no-env-file", "test", ...args]);
  } else {
    // This owned cluster contains only disposable tests; never initialize or stop a user's DB.
    const directory = await mkdtemp(join(tmpdir(), "probabl-postgres-tests-"));
    const data = join(directory, "data");
    const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = probe.port;
    await probe.stop(true);
    if (await run("initdb", ["-D", data, "-A", "trust", "-U", "probabl_test"]))
      throw new Error(
        "PostgreSQL initdb failed; install PostgreSQL or set local TEST_DATABASE_URL",
      );
    try {
      if (
        await run("pg_ctl", [
          "-D",
          data,
          "-l",
          join(directory, "postgres.log"),
          "-o",
          `-h 127.0.0.1 -p ${port} -k ${directory}`,
          "start",
        ])
      )
        throw new Error("isolated PostgreSQL startup failed");
      process.exitCode = await run("bun", ["--no-env-file", "test", ...args], {
        ...process.env,
        TEST_DATABASE_URL: `postgresql://probabl_test@127.0.0.1:${port}/postgres`,
      });
    } finally {
      cleaning = true;
      // Also handle pg_ctl interrupted after starting the server but before reporting success.
      if (await Bun.file(join(data, "postmaster.pid")).exists())
        await run("pg_ctl", ["-D", data, "-m", "fast", "stop"]);
      // Keep failed-run logs recoverable in the exact temporary directory above.
      console.info(`PostgreSQL test logs: ${directory}`);
    }
  }
} finally {
  process.off("SIGTERM", onTerm);
  process.off("SIGINT", onInt);
  if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
}
