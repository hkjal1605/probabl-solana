import { serverApi } from "@/lib/api/server";
import { MarketsExplorer } from "./components/MarketsExplorer";
export async function MarketsPageModule() {
  return <MarketsExplorer markets={await serverApi.markets()} />;
}
