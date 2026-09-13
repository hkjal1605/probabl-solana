import { serverApi } from "@/lib/api/server";
import { Landing } from "./components/Landing";
export async function HomePageModule() {
  return <Landing initialMarkets={await serverApi.markets()} />;
}
