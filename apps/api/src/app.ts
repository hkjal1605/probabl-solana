import { TradingUnavailableError } from "@conditional-stocks/config";
import { OperationLeaseLost, OperationLeaseUnavailable } from "@conditional-stocks/db/gateway";
import { GatewayError, GatewayErrorCode } from "@conditional-stocks/gateway";
import { MarketDataError } from "@conditional-stocks/market-data";
import { requestLogging } from "@conditional-stocks/shared/http";
import { Hono } from "hono";
import type { AdminEvidenceService } from "./admin-evidence-service.ts";
import { logger } from "./logger.ts";
import type { GatewayService } from "./service.ts";

const json = (value: unknown, status = 200): Response =>
  new Response(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
    { headers: { "content-type": "application/json; charset=utf-8" }, status },
  );

const requireService = (service: GatewayService | undefined): GatewayService => {
  if (!service) {
    throw new GatewayError(GatewayErrorCode.RpcUnavailable, "gateway is not configured", 503);
  }
  return service;
};

const requireAdmin = (service: AdminEvidenceService | undefined): AdminEvidenceService => {
  if (!service) {
    throw new MarketDataError("ADMIN_DISABLED", "admin evidence workflow is not configured", 503);
  }
  return service;
};

export const createApp = (service?: GatewayService, adminService?: AdminEvidenceService) => {
  const app = new Hono();
  app.use("*", requestLogging(logger));

  app.onError((error) => {
    if (error instanceof OperationLeaseLost || error instanceof OperationLeaseUnavailable)
      return json(
        { error: { code: "operation-busy", message: error.message, retryable: true } },
        503,
      );
    if (error instanceof TradingUnavailableError)
      return json(
        { error: { code: "trading-unavailable", message: error.message, retryable: true } },
        503,
      );
    if (error instanceof GatewayError) {
      return json(
        {
          error: {
            code: error.code,
            details: error.details,
            message: error.message,
            retryable: error.status >= 500,
          },
        },
        error.status,
      );
    }
    if (error instanceof MarketDataError) {
      return json(
        {
          error: {
            code: error.code,
            message: error.message,
            retryable: error.status >= 500,
          },
        },
        error.status,
      );
    }
    return json(
      {
        error: {
          code: error instanceof SyntaxError ? GatewayErrorCode.InvalidRequest : "internal-error",
          message:
            error instanceof SyntaxError
              ? "Request body must be valid JSON"
              : "Request could not be completed; retry using the same idempotency key",
          retryable: !(error instanceof SyntaxError),
        },
      },
      error instanceof SyntaxError ? 400 : 500,
    );
  });

  app.get("/health", (context) =>
    context.json({
      service: "conditional-stocks-api",
      status: "ok",
      version: "0.1.0",
    }),
  );
  app.get("/ready", async () => {
    await requireService(service).safety?.assertCanTrade([]);
    return json({ healthy: true, protocolVersion: 2 });
  });
  app.get("/v1/system/readiness", async (context) => {
    const marketId = context.req.query("marketId");
    if (marketId && !/^0x[0-9a-fA-F]{64}$/.test(marketId))
      return json({ error: "invalid-market-id" }, 400);
    await requireService(service).safety?.assertCanTrade(marketId ? [marketId] : []);
    return json({ healthy: true, protocolVersion: 2 });
  });

  app.get("/v1", (context) =>
    context.json({
      kycGating: false,
      marketCreation: "manual-admin",
      marketResolution: "manual-admin",
      name: "Conditional Stocks API",
      settlementAutomation: false,
    }),
  );

  app.post("/v1/auth/challenge", async (context) =>
    json(await requireService(service).createChallenge(await context.req.json())),
  );
  app.post("/v1/auth/verify", async (context) =>
    json(await requireService(service).verifyChallenge(await context.req.json())),
  );

  app.post("/v1/orders/prepare", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await gateway.prepareOrder(await context.req.json(), session));
  });

  app.post("/v1/orders/transaction", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await gateway.orderTransaction(await context.req.json(), session), 200);
  });

  app.post("/v1/orders/cancel/prepare", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await gateway.prepareCancellation(await context.req.json(), session));
  });
  app.post("/v1/orders/recovery/prepare", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await gateway.prepareOrderRecovery(await context.req.json(), session));
  });

  app.post("/v1/payouts/withdraw/prepare", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await gateway.preparePayoutWithdrawal(await context.req.json(), session));
  });

  app.post("/v1/orders/cancel/submit", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(
      await gateway.submitCancellation(
        await context.req.json(),
        session,
        context.req.header("idempotency-key"),
      ),
      202,
    );
  });

  app.get("/v1/orders/:orderHash", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await gateway.canonicalOrder(context.req.param("orderHash"), session));
  });

  app.get("/v1/operations/:operationId", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await gateway.operation(context.req.param("operationId"), session));
  });

  for (const kind of ["merge", "redeem"] as const) {
    app.post(`/v1/positions/${kind}/prepare`, async (context) => {
      const gateway = requireService(service);
      const session = await gateway.authenticate(context.req.header("authorization"));
      return json(await gateway.preparePositionAction(kind, await context.req.json(), session));
    });
    app.post(`/v1/positions/${kind}/submit`, async (context) => {
      const gateway = requireService(service);
      const session = await gateway.authenticate(context.req.header("authorization"));
      return json(
        await gateway.submitPositionAction(
          kind,
          await context.req.json(),
          session,
          context.req.header("idempotency-key"),
        ),
        202,
      );
    });
  }

  app.post("/v1/admin/polymarket/metadata/fetch", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(
      await requireAdmin(adminService).fetchPolymarketMetadata(await context.req.json(), session),
    );
  });

  app.post("/v1/admin/evidence/creation/prepare", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(
      await requireAdmin(adminService).prepareCreation(await context.req.json(), session),
      201,
    );
  });

  app.post("/v1/admin/evidence/resolution/prepare", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(
      await requireAdmin(adminService).prepareResolution(await context.req.json(), session),
      201,
    );
  });

  app.get("/v1/admin/evidence", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await requireAdmin(adminService).packets(session));
  });

  app.get("/v1/admin/history", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await requireAdmin(adminService).history(session));
  });

  app.get("/v1/admin/evidence/:packetHash", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(await requireAdmin(adminService).packet(context.req.param("packetHash"), session));
  });

  app.post("/v1/admin/evidence/:packetHash/review", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(
      await requireAdmin(adminService).review(
        context.req.param("packetHash"),
        await context.req.json(),
        session,
      ),
    );
  });

  app.post("/v1/admin/evidence/:packetHash/transaction", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(
      await requireAdmin(adminService).transaction(context.req.param("packetHash"), session),
    );
  });

  app.post("/v1/admin/evidence/:packetHash/verify-transaction", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(
      await requireAdmin(adminService).verifyTransaction(
        context.req.param("packetHash"),
        await context.req.json(),
        session,
      ),
    );
  });

  app.post("/v1/admin/evidence/:packetHash/reconcile", async (context) => {
    const gateway = requireService(service);
    const session = await gateway.authenticate(context.req.header("authorization"));
    return json(
      await requireAdmin(adminService).reconcile(
        context.req.param("packetHash"),
        await context.req.json(),
        session,
      ),
    );
  });

  app.get("/v1/markets/:marketId/polymarket", (context) =>
    requireAdmin(adminService)
      .marketData(context.req.param("marketId"))
      .then((value) => json(value)),
  );

  app.get("/v1/markets/:marketId/probability", (context) =>
    requireAdmin(adminService)
      .marketProbability(context.req.param("marketId"))
      .then((value) => json(value)),
  );

  app.get("/v1/markets/:marketId/resolution-evidence", async (context) =>
    json(await requireAdmin(adminService).publicResolutionEvidence(context.req.param("marketId"))),
  );

  app.get("/v1/attachments/:contentHash", async (context) => {
    const content = await requireAdmin(adminService).publicAttachment(
      context.req.param("contentHash"),
    );
    return new Response(new Uint8Array(content).buffer, {
      headers: {
        "content-type": "application/octet-stream",
        "content-disposition": "attachment; filename=protocol-evidence.bin",
        "x-content-type-options": "nosniff",
        "cache-control": "public, max-age=31536000, immutable",
      },
    });
  });

  return app;
};

export type Api = ReturnType<typeof createApp>;
