import { expect, test } from "bun:test";
import { testDatabase } from "@conditional-stocks/db/polymarket/testing";
import { conditionId } from "./helpers.ts";

// A spawned process must exit naturally with an OPEN client socket: clearing an
// interval in onClose alone is insufficient when Bun force-stops active sockets.
test("open public WebSocket cannot retain timers, DB reads or process after SIGTERM", async () => {
  const fixture = await testDatabase();
  await fixture.database.end();
  const child = Bun.spawn(
    ["bun", "--no-env-file", new URL("./fixtures/shutdown.ts", import.meta.url).pathname],
    {
      env: {
        PATH: process.env.PATH,
        TMPDIR: process.env.TMPDIR,
        LOG_LEVEL: "silent",
        DATABASE_URL: fixture.connectionString,
      },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let socket: WebSocket | undefined;
  const timer = setTimeout(() => {
    if (child.exitCode === null) child.kill("SIGKILL");
  }, 5000);
  const stderr = new Response(child.stderr).text();
  try {
    const reader = child.stdout.getReader();
    const first = await reader.read();
    if (first.done) throw new Error(`Shutdown child failed to start: ${await stderr}`);
    const { port } = JSON.parse(new TextDecoder().decode(first.value));
    // Continue draining the child pipe without retaining its entire lifetime.
    const drain = (async () => {
      while (!(await reader.read()).done) {
        /* drain */
      }
    })();
    socket = new WebSocket(`ws://127.0.0.1:${port}/v1/polymarket/conditions/${conditionId}/stream`);
    await Promise.race([
      new Promise<void>((resolve, reject) => {
        if (!socket) throw new Error("Missing client socket");
        socket.onmessage = () => resolve();
        socket.onerror = () => reject(new Error("WebSocket failed"));
      }),
      child.exited.then(() => {
        throw new Error("Child exited before subscription");
      }),
    ]);
    child.kill("SIGTERM");
    expect(await child.exited).toBe(0);
    await drain;
    expect(await stderr).toBe("");
  } finally {
    clearTimeout(timer);
    socket?.close();
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
}, 10_000);
