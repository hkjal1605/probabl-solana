/** Operator-side DNS only. The API token stays local and is never printed or sent to EC2. */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";

const root = resolve(import.meta.dir, "../../..");
const source = parseEnv(readFileSync(resolve(root, ".env.devnet"), "utf8"));
const token = source.CLOUDFLARE_API_TOKEN?.trim();
if (!token || /[\r\n]/.test(token))
  throw new Error("CLOUDFLARE_API_TOKEN is missing or malformed");
const domain = "api-solana.probabl.trade";
const ipv4 = "57.183.26.209";
type RecordRow = {
  id: string;
  type: string;
  name: string;
  content: string;
  proxied?: boolean;
  ttl: number;
};

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(20000),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
  });
  const body = (await response.json()) as {
    success: boolean;
    errors?: { code: number }[];
    result: T;
    result_info?: { total_pages: number };
  };
  if (!response.ok || !body.success)
    throw new Error(
      `Cloudflare request failed: HTTP ${response.status}; codes=${body.errors?.map((e) => e.code).join(",")}`,
    );
  if ((body.result_info?.total_pages ?? 1) > 1)
    throw new Error("Unexpected pagination; refusing a partial DNS inventory");
  return body.result;
}
try {
  const zones = await api<
    { id: string; name: string; status: string; name_servers: string[] }[]
  >("/zones?name=probabl.trade&status=active&per_page=50");
  if (zones.length !== 1 || zones[0]!.name !== "probabl.trade")
    throw new Error("Expected one active probabl.trade zone");
  const zone = zones[0]!;
  const records = await api<RecordRow[]>(
    `/zones/${zone.id}/dns_records?name=${domain}&per_page=100`,
  );
  const caa = await api<RecordRow[]>(
    `/zones/${zone.id}/dns_records?type=CAA&name=probabl.trade&per_page=100`,
  );
  console.log(
    JSON.stringify({
      mode: process.argv[2] ?? "inspect",
      zone: zone.name,
      nameservers: zone.name_servers,
      records,
      caa,
    }),
  );
  if (process.argv[2] === "apply") {
    // Never delete an unrelated record, replace a CNAME, or route around an existing deployment.
    if (
      records.some(
        (r) =>
          ["A", "AAAA", "CNAME", "NS", "HTTPS", "SVCB"].includes(r.type) &&
          !(r.type === "A" && r.content === ipv4 && r.proxied === false),
      )
    )
      throw new Error(
        "Conflicting routing record exists; operator review required",
      );
    const matching = records.filter((r) => r.type === "A");
    if (matching.length > 1) throw new Error("Ambiguous duplicate A records");
    const record =
      matching[0] ??
      (await api<RecordRow>(`/zones/${zone.id}/dns_records`, {
        method: "POST",
        body: JSON.stringify({
          type: "A",
          name: domain,
          content: ipv4,
          ttl: 300,
          proxied: false,
          comment:
            "Solana devnet API on EC2; origin TLS managed by Certbot HTTP-01",
        }),
      }));
    console.log(
      JSON.stringify({
        configured: true,
        created: matching.length === 0,
        name: record.name,
        content: record.content,
        proxied: record.proxied,
        ttl: record.ttl,
      }),
    );
  } else if (process.argv[2] && process.argv[2] !== "inspect")
    throw new Error("Use inspect or apply");
} catch (error) {
  // Do not serialize fetch errors, headers, or any raw provider response.
  const message =
    error instanceof Error
      ? error.message.replaceAll(token, "[REDACTED]")
      : "DNS operation failed";
  console.error(JSON.stringify({ configured: false, message }));
  process.exitCode = 1;
}
