// Retired endpoint: stale clients cannot re-enable a simulated wallet or market feed.
export async function POST() {
  return Response.json(
    { error: "Demo mode is no longer available in this app." },
    {
      status: 410,
      headers: {
        "cache-control": "no-store",
        "set-cookie": "probabl-mode=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax",
      },
    },
  );
}
