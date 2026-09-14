import { serverApi } from "@/lib/api/server";

export async function GET(request: Request) {
  try {
    return Response.json(
      { markets: await serverApi.liveMarkets(new URL(request.url).searchParams.get("marketId") ?? undefined) },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: { message: "Market data is temporarily unavailable. Please retry." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
