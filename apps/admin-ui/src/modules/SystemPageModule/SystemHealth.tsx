"use client";

import { digest, envelope, key, SolanaClient } from "@conditional-stocks/solana-client";
import { useQuery } from "@tanstack/react-query";
import { Activity, ClipboardCopy, PauseCircle, PlayCircle, RefreshCw } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { QueryStatus } from "@/components/data/QueryStatus";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { adminConfig } from "@/config/protocol";
import { requestJson } from "@/lib/admin-api";
import { time } from "@/lib/format";

interface Health {
  checkedAt: string;
  services: Array<{
    detail: unknown;
    latencyMs?: number;
    name: string;
    status: "healthy" | "degraded" | "offline" | "unknown";
  }>;
}
export function SystemHealth() {
  const admin = useAdmin();
  const query = useQuery({
    queryKey: ["health", adminConfig.chainId],
    queryFn: ({ signal }) => requestJson<Health>("/api/health", { signal }),
    refetchInterval: 10_000,
  });
  const [reason, setReason] = useState("");
  const [paused, setPaused] = useState(true);
  const [payload, setPayload] = useState("");
  const build = () => {
    if (!adminConfig.exchange) {
      toast.error("Exchange address is not configured");
      return;
    }
    const client = new SolanaClient(adminConfig),
      transaction = envelope(
        [
          client.ix(
            "pause",
            { paused, reason: [...digest(reason)] },
            { guardian: key(admin.account ?? adminConfig.marketAdmin), config: client.config },
          ),
        ],
        client.program,
      );
    setPayload(
      JSON.stringify(
        {
          ...transaction,
          metadata: { paused, reason, genesisHash: adminConfig.genesisHash },
        },
        null,
        2,
      ),
    );
  };
  return (
    <>
      <QueryStatus query={query} />
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
        {(query.data?.services ?? []).map((service) => (
          <Card className="ring-0" key={service.name}>
            <CardContent>
              <div className="flex items-center justify-between">
                <Activity className="size-4 text-muted-foreground" />
                <Badge
                  variant={
                    service.status === "healthy"
                      ? "positive"
                      : service.status === "unknown"
                        ? "secondary"
                        : "destructive"
                  }
                >
                  {service.status}
                </Badge>
              </div>
              <p className="mt-6 font-semibold">{service.name}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {service.latencyMs === undefined
                  ? "Endpoint not configured"
                  : `${service.latencyMs} ms response`}
              </p>
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="mt-3 flex items-center justify-between text-xs text-muted-foreground">
        <span>Checked {query.data ? time(query.data.checkedAt) : "—"}</span>
        <Button size="sm" variant="ghost" onClick={() => query.refetch()}>
          <RefreshCw />
          Refresh
        </Button>
      </div>
      <Card className="mt-8 ring-0">
        <CardHeader>
          <CardTitle>Incident action · global trading state</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="max-w-2xl text-sm leading-6 text-muted-foreground">
            Prepare Solana instructions for a guardian to pause or resume new order opening.
            Existing direct recovery paths stay available according to contract rules.
          </p>
          <div className="mt-5 grid gap-4 sm:grid-cols-[180px_1fr_auto]">
            <div>
              <Label htmlFor="pause-state">Action</Label>
              <Select
                value={paused ? "pause" : "resume"}
                onValueChange={(value) => {
                  setPaused(value === "pause");
                  setPayload("");
                }}
              >
                <SelectTrigger id="pause-state" className="mt-2 w-full bg-secondary">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="pause">Pause trading</SelectItem>
                  <SelectItem value="resume">Resume trading</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="incident-reason">Incident reason</Label>
              <Input
                id="incident-reason"
                className="mt-2"
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setPayload("");
                }}
                placeholder="Incident ID and concise rationale"
              />
            </div>
            <Button
              className="self-end"
              variant={paused ? "destructive" : "default"}
              onClick={build}
              disabled={!reason}
            >
              {paused ? <PauseCircle /> : <PlayCircle />}Build payload
            </Button>
          </div>
          {payload && (
            <div className="mt-5 rounded-xl bg-muted p-4">
              <pre className="max-h-52 overflow-auto whitespace-pre-wrap break-all text-xs">
                {payload}
              </pre>
              <Button
                className="mt-3"
                size="sm"
                variant="outline"
                onClick={() =>
                  navigator.clipboard
                    .writeText(payload)
                    .then(() => toast.success("Incident payload copied"))
                }
              >
                <ClipboardCopy />
                Copy Solana instructions
              </Button>
            </div>
          )}
        </CardContent>
      </Card>
    </>
  );
}
