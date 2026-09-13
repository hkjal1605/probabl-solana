import type { Metadata } from "next";
import { OrdersPageModule } from "@/modules/OrdersPageModule";
export const metadata: Metadata = { title: "Orders" };
export default function OrdersPage() {
  return <OrdersPageModule />;
}
