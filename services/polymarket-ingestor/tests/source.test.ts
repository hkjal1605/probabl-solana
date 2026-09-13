import { expect, test } from "bun:test";
import { loadPolymarketEnvironment } from "../src/environment.ts";
import { OfficialPolymarketSource } from "../src/source.ts";

test("Polymarket configuration requires credentials, supported protocols and positive thresholds", () => {
  const base = { POLYMARKET_INTERNAL_TOKEN: "local-fixture-token" };
  expect(loadPolymarketEnvironment(base).port).toBe(42073);
  for (const overrides of [
    { POLYMARKET_INTERNAL_TOKEN: "" },
    { POLYMARKET_PORT: "0" },
    { POLYMARKET_RECONCILE_MS: "1.5" },
    { POLYMARKET_METADATA_POLL_MS: "-1" },
    { POLYMARKET_STANDARD_NOTIONAL_X6: "0" },
    { POLYMARKET_STALE_AFTER_MS: "-1" },
    { POLYMARKET_CLOB_URL: "file:///bad" },
    { POLYMARKET_GAMMA_URL: "ftp://bad" },
    { POLYMARKET_WS_URL: "file:///bad" },
  ])
    expect(() => loadPolymarketEnvironment({ ...base, ...overrides })).toThrow();
  expect(
    loadPolymarketEnvironment({
      ...base,
      POLYMARKET_HOST: "0.0.0.0",
      POLYMARKET_WS_URL: "ws://127.0.0.1:42073/",
    }).websocketUrl,
  ).toBe("ws://127.0.0.1:42073");
});

test("official HTTP adapter validates identities, bounds responses and classifies transport failures", async () => {
  let mode = "valid";
  const paths: string[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      paths.push(new URL(request.url).pathname + new URL(request.url).search);
      if (mode === "error") return new Response("unavailable", { status: 503 });
      if (mode === "invalid") return new Response("{broken");
      if (mode === "declared-large")
        return new Response(" ".repeat(OfficialPolymarketSource.maximumResponseBytes + 1));
      if (mode === "stream-large") {
        let chunks = 0;
        return new Response(
          new ReadableStream({
            async pull(controller) {
              await Bun.sleep(1);
              controller.enqueue(new Uint8Array(1024 * 1024));
              if (++chunks === 6) controller.close();
            },
          }),
        );
      }
      if (mode === "empty") return new Response(null, { status: 204 });
      return Response.json({ id: "42" });
    },
  });
  const url = server.url.href.replace(/\/$/, "");
  const source = new OfficialPolymarketSource(url, url, url.replace("http:", "ws:"));
  try {
    expect(await source.getMarket("42")).toEqual({ id: "42" });
    expect(await source.getBook("111")).toEqual({ id: "42" });
    expect(paths).toEqual(["/markets/42", "/book?token_id=111"]);
    for (const id of ["", "../secret", "a".repeat(257)])
      await expect(source.getMarket(id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    for (const id of ["0", "-1", "1.1", "abc"])
      await expect(source.getBook(id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    for (const value of ["error", "invalid", "declared-large", "stream-large", "empty"]) {
      mode = value;
      await expect(source.getMarket("42")).rejects.toMatchObject({
        code: "SOURCE_UNAVAILABLE",
        status: 503,
      });
    }
  } finally {
    await server.stop(true);
  }
  await expect(source.getBook("111")).rejects.toMatchObject({ code: "SOURCE_UNAVAILABLE" });
});

test("official WebSocket adapter subscribes, decodes batched events, and reports one disconnect", async () => {
  const events: unknown[] = [];
  const disconnects: string[] = [];
  const subscribed = Promise.withResolvers<void>();
  const disconnected = Promise.withResolvers<void>();
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request, server) {
      if (server.upgrade(request)) return;
      return new Response("upgrade required", { status: 400 });
    },
    websocket: {
      open(socket) {
        socket.send("PONG");
      },
      message(socket, data) {
        if (String(data) === "PING") {
          socket.send("PONG");
          return;
        }
        expect(JSON.parse(String(data))).toEqual({ assets_ids: ["111"], type: "market" });
        subscribed.resolve();
        socket.send("PONG");
        socket.send(JSON.stringify([{ id: 1 }, { id: 2 }]));
        socket.send(JSON.stringify({ id: 3 }));
        socket.send("{bad");
      },
    },
  });
  const source = new OfficialPolymarketSource(
    "http://unused",
    "http://unused",
    server.url.href.replace("http:", "ws:"),
  );
  const connection = source.connect(
    ["111"],
    (event) => events.push(event),
    (reason) => {
      disconnects.push(reason);
      disconnected.resolve();
    },
  );
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      disconnected.promise,
      new Promise<void>((_, reject) => {
        timeout = setTimeout(
          () => reject(new Error(`websocket timeout: ${JSON.stringify({ events, disconnects })}`)),
          2000,
        );
      }),
    ]);
    await subscribed.promise;
    expect(events).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(disconnects).toHaveLength(1);
    expect(disconnects[0]).toContain("invalid-message");
  } finally {
    clearTimeout(timeout);
    connection.close();
    await server.stop(true);
  }
});
