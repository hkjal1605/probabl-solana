import { serverApi } from "@/lib/api/server";
import { ResolutionClient } from "./components/ResolutionClient";
export async function ResolutionPageModule({ selected }: { selected?: string }) {
  const markets = await serverApi.markets();
  return <ResolutionClient markets={markets} selected={selected} />;
}
