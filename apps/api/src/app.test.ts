import { describe, expect, test } from "bun:test";

import { createApp } from "./app.ts";

describe("API", () => {
  test("reports health", async () => {
    const response = await createApp().request("/health");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      service: "conditional-stocks-api",
      status: "ok",
      version: "0.1.0",
    });
  });

  test("reports the fixed settlement model", async () => {
    const response = await createApp().request("/v1");
    const body = await response.json();

    expect(body).toMatchObject({
      marketCreation: "manual-admin",
      marketResolution: "manual-admin",
      settlementAutomation: false,
    });
  });
});
