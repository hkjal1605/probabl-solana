import { serverApi } from "@/lib/api/server";

export async function GET() {
  try {
    return Response.json(
      { markets: await serverApi.liveMarkets() },
      { headers: { "cache-control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: { message: "Market data is temporarily unavailable. Please retry." } },
      { status: 503, headers: { "cache-control": "no-store" } },
    );
  }
}
