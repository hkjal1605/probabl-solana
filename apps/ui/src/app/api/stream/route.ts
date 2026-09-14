import { upstreamUrl } from "@/lib/api/upstream";

export async function GET(request: Request) {
  const target = new URL("/stream", upstreamUrl("indexer"));
  const owner = new URL(request.url).searchParams.get("owner");
  if (owner) target.searchParams.set("owner", owner);
  const upstream = await fetch(target, {
    signal: request.signal, cache: "no-store", redirect: "manual",
    headers: { accept: "text/event-stream" },
  });
  if (!upstream.ok) {
    await upstream.body?.cancel();
    return new Response(null, { status: 503 });
  }
  return new Response(upstream.body, { headers: {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  } });
}
