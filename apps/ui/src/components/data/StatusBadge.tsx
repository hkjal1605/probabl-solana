import { CircleAlert, CircleCheck, CircleDashed, LockKeyhole, Radio } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { DataQuality, MarketLifecycle } from "@/types/api";

export function LifecycleBadge({ state }: { state: MarketLifecycle }) {
  if (state === "open")
    return (
      <Badge variant="positive">
        <Radio aria-hidden="true" />
        Open
      </Badge>
    );
  if (state === "redeemable")
    return (
      <Badge variant="default">
        <CircleCheck aria-hidden="true" />
        Redeemable
      </Badge>
    );
  if (state === "frozen" || state === "awaiting-resolution")
    return (
      <Badge variant="warning">
        <LockKeyhole aria-hidden="true" />
        {state === "frozen" ? "Frozen" : "Manual review"}
      </Badge>
    );
  return (
    <Badge variant="secondary">
      <CircleDashed aria-hidden="true" />
      {state.replace("-", " ")}
    </Badge>
  );
}

export function QualityBadge({ quality }: { quality: DataQuality }) {
  return quality === "valid" ? (
    <Badge variant="positive">
      <CircleCheck />
      Live source
    </Badge>
  ) : (
    <Badge variant={quality === "low-depth" ? "warning" : "destructive"}>
      <CircleAlert />
      {quality.replace("-", " ")}
    </Badge>
  );
}
