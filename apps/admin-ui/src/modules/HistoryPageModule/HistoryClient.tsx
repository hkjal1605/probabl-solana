"use client";

import { useQuery } from "@tanstack/react-query";
import { History } from "lucide-react";
import { QueryStatus } from "@/components/data/QueryStatus";
import { useAdmin } from "@/components/providers/AdminProvider";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { adminConfig } from "@/config/protocol";
import { adminRequest } from "@/lib/admin-api";
import { short, time } from "@/lib/format";

interface Action {
  action: string;
  actor: string;
  createdAt: string;
  details: unknown;
  id: string;
  packetHash: string | null;
}
export function HistoryClient() {
  const admin = useAdmin();
  const query = useQuery({
    queryKey: ["admin-history", admin.account, adminConfig.genesisHash],
    queryFn: ({ signal }) =>
      adminRequest<{ actions: Action[] }>(admin.token ?? "", "admin/history", { signal }),
    enabled: Boolean(admin.token),
    refetchInterval: 10_000,
  });
  const actions = query.data?.actions ?? [];
  return (
    <Card className="ring-0">
      <CardContent>
        <QueryStatus query={query} />
        {actions.length === 0 ? (
          <div className="flex min-h-56 flex-col items-center justify-center text-center">
            <History className="text-muted-foreground" />
            <p className="mt-4 text-sm text-muted-foreground">
              {query.isSuccess
                ? "No append-only admin actions recorded."
                : "Waiting for indexed admin history."}
            </p>
          </div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Time</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Actor</TableHead>
                <TableHead>Packet</TableHead>
                <TableHead>Details</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {actions.map((action) => (
                <TableRow key={action.id}>
                  <TableCell>{time(action.createdAt)}</TableCell>
                  <TableCell>
                    <Badge variant="outline">{action.action.replaceAll("_", " ")}</Badge>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{short(action.actor, 6)}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {action.packetHash ? short(action.packetHash, 6) : "—"}
                  </TableCell>
                  <TableCell>
                    <code className="block max-w-72 truncate text-xs">
                      {JSON.stringify(action.details)}
                    </code>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
