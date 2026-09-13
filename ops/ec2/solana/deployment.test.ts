import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import config from "./ecosystem.config.cjs";

describe("Solana EC2 deployment boundaries", () => {
  test("only the three native services run, once each, without a backend signer", () => {
    expect(config.apps.map((app: { name: string }) => app.name)).toEqual([
      "probabl-sol-indexer",
      "probabl-sol-polymarket",
      "probabl-sol-api",
    ]);
    for (const app of config.apps) {
      expect(app.instances).toBe(1);
      expect(app.exec_mode).toBe("fork");
      expect(app.script).toBe("/usr/local/bin/bun");
      expect(app.args[0]).toContain("/.local/ec2/env/");
      expect(app.args[0]).not.toContain("bootstrap.env");
      expect(JSON.stringify(app.env)).not.toMatch(
        /PRIVATE_KEY|DATABASE_URL|INTERNAL_TOKEN/,
      );
    }
    expect(config.apps[0].args[1]).toEndWith(
      "services/solana-indexer/src/main.ts",
    );
    expect(config.apps[2].args[1]).toEndWith("apps/api/src/solana.ts");
  });
  test("ingress exposes read-only projections and blocks private endpoints", () => {
    const nginx = readFileSync(resolve(import.meta.dir, "nginx.conf"), "utf8");
    expect(nginx).toContain("listen 80 default_server;");
    expect(nginx).toContain("location ^~ /internal/ { return 404; }");
    expect(nginx).toContain("limit_except GET { deny all; }");
    expect(nginx).toContain("location / { return 404; }");
    const logFormat = nginx.match(/log_format probabl_sol[\s\S]*?;/)?.[0];
    expect(logFormat).toBeDefined();
    expect(logFormat).not.toContain("$request_uri");
    expect(nginx).not.toContain("$http_authorization");
    expect(nginx).toContain("proxy_set_header X-Forwarded-For $remote_addr;");
    expect(nginx).toContain(
      "^/v1/admin/evidence/(creation|resolution)/prepare$",
    );
  });
  test("TLS, fixed-host redirects and automatic HTTP-01 renewal remain configured", () => {
    const nginx = readFileSync(resolve(import.meta.dir, "nginx.conf"), "utf8");
    expect(nginx).toContain("listen 443 ssl default_server;");
    expect(nginx).toContain("ssl_protocols TLSv1.2 TLSv1.3;");
    expect(nginx).toContain(
      "/etc/letsencrypt/live/api-solana.probabl.trade/fullchain.pem",
    );
    expect(nginx).toContain(
      "return 308 https://api-solana.probabl.trade$request_uri;",
    );
    expect(nginx).toContain("location ^~ /.well-known/acme-challenge/");
    expect(nginx).toContain("root /var/www/probabl-sol-acme;");
    expect(nginx).not.toContain("includeSubDomains");
    expect(nginx).not.toContain("CF-Connecting-IP");
  });
});
