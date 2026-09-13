"use client";

import { Badge } from "@conditional-stocks/ui-kit/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@conditional-stocks/ui-kit/card";
import { useQuery } from "@tanstack/react-query";
import { Activity, ClipboardCheck, FileCheck2, Gavel, ShieldAlert } from "lucide-react";
import { QueryStatus } from "@/components/data/QueryStatus";
import { useAdmin } from "@/components/providers/AdminProvider";
import { adminConfig } from "@/config/protocol";
import { adminRequest, type EvidenceView, requestJson } from "@/lib/admin-api";
import { time } from "@/lib/format";

interface Health {
  checkedAt: string;
  services: Array<{
    latencyMs?: number;
    name: string;
    status: "healthy" | "degraded" | "offline" | "unknown";
  }>;
}
export function DashboardClient() {
  const admin = useAdmin();
  const evidence = useQuery({
    queryKey: ["evidence", admin.account, adminConfig.genesisHash],
    queryFn: ({ signal }) =>
      adminRequest<{ packets: EvidenceView[] }>(admin.token ?? "", "admin/evidence", { signal }),
    enabled: Boolean(admin.token),
    refetchInterval: 10_000,
  });
  const health = useQuery({
    queryKey: ["health", adminConfig.chainId],
    queryFn: ({ signal }) => requestJson<Health>("/api/health", { signal }),
    refetchInterval: 10_000,
  });
  const packets = evidence.data?.packets ?? [];
  const services = health.data?.services ?? [];
  return (
    <>
      <QueryStatus query={evidence} />
      <QueryStatus query={health} />
      <div className="mt-8 grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <Metric
          icon={ClipboardCheck}
          label="Awaiting review"
          value={
            evidence.isSuccess
              ? String(packets.filter((item) => item.status === "prepared").length)
              : "—"
          }
        />
        <Metric
          icon={FileCheck2}
          label="Approved packets"
          value={
            evidence.isSuccess
              ? String(packets.filter((item) => item.status === "approved").length)
              : "—"
          }
        />
        <Metric
          icon={Gavel}
          label="Resolution packets"
          value={
            evidence.isSuccess
              ? String(
                  packets.filter((item) => item.envelope.packet.kind === "market-resolution")
                    .length,
                )
              : "—"
          }
        />
        <Metric
          icon={Activity}
          label="Healthy services"
          value={
            health.isSuccess
              ? `${services.filter((item) => item.status === "healthy").length}/${services.length}`
              : "—"
          }
        />
      </div>
      <div className="mt-5 grid gap-5 xl:grid-cols-[1.25fr_0.75fr]">
        <Card>
          <CardHeader>
            <CardTitle>Workflow queue</CardTitle>
          </CardHeader>
          <CardContent>
            {packets.length === 0 ? (
              <p className="py-12 text-center text-sm text-muted-foreground">
                {evidence.isSuccess
                  ? "No evidence packets are queued."
                  : "Evidence data is not available yet."}
              </p>
            ) : (
              <div className="space-y-2">
                {packets.slice(0, 6).map((item) => (
                  <div
                    key={item.envelope.packetHash}
                    className="flex items-center gap-3 rounded-xl border p-3"
                  >
                    <span className="flex size-9 items-center justify-center rounded-lg bg-muted">
                      <ClipboardCheck className="size-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">
                        {item.envelope.packet.kind === "market-creation"
                          ? (item.envelope.packet.polymarket?.question ?? "Market creation")
                          : `Resolve ${item.envelope.packet.localMarket?.marketId ?? "market"}`}
                      </p>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        Prepared {time(item.envelope.packet.preparedAt)}
                      </p>
                    </div>
                    <Badge
                      variant={
                        item.status === "approved"
                          ? "positive"
                          : item.status === "rejected"
                            ? "destructive"
                            : "warning"
                      }
                    >
                      {item.status}
                    </Badge>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Service pulse</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {services.map((service) => (
              <div key={service.name} className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span
                    className={`size-2 rounded-full ${service.status === "healthy" ? "bg-positive" : service.status === "unknown" ? "bg-muted-foreground" : "bg-danger"}`}
                  />
                  <span>{service.name}</span>
                </div>
                <span className="text-xs text-muted-foreground">
                  {service.latencyMs === undefined ? service.status : `${service.latencyMs} ms`}
                </span>
              </div>
            ))}
            <div className="mt-5 flex gap-2 rounded-xl bg-warning-soft p-3 text-warning">
              <ShieldAlert className="mt-0.5 size-4 shrink-0" />
              <p className="text-xs leading-5">
                UI health is advisory. Reconciliation and onchain role checks remain authoritative.
              </p>
            </div>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
function Metric({
  icon: Icon,
  label,
  value,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
}) {
  return (
    <Card size="sm">
      <CardContent>
        <Icon className="size-4 text-muted-foreground" />
        <p className="mt-4 text-xs text-muted-foreground">{label}</p>
        <p className="mt-1 text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}
