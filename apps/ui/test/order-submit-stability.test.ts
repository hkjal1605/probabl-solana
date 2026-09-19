import { expect, test } from "bun:test";
import { join } from "node:path";

test("background index updates do not cancel an in-flight order", async () => {
  const child = Bun.spawn(
    [process.execPath, "test", "./test/fixtures/order-submit-stability.tsx"],
    {
      cwd: join(import.meta.dir, ".."),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [code, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  expect(code, stdout + stderr).toBe(0);
}, 15_000);
