import { expect, test } from "bun:test";
import { ApiError } from "../src/lib/api/client";
import { reviewWithSession } from "../src/lib/trading/review-session";

test("successful public or authenticated review never prompts", async () => {
  for (const token of [null, "saved"]) {
    let prompts = 0;
    expect(await reviewWithSession({ token,
      request: async (received) => { expect(received).toBe(token ?? undefined); return "quote"; },
      authenticate: async () => { prompts++; return "new"; }, assertCurrent() {},
    })).toBe("quote");
    expect(prompts).toBe(0);
  }
});

test("missing or expired sessions authenticate and retry exactly once", async () => {
  for (const token of [null, "expired"]) {
    const requests: (string | undefined)[] = [];
    let prompts = 0;
    expect(await reviewWithSession({ token,
      request: async (received) => {
        requests.push(received);
        if (requests.length === 1) throw new ApiError("Sign in", 401, null);
        return "quote";
      },
      authenticate: async () => { prompts++; return "new"; }, assertCurrent() {},
    })).toBe("quote");
    expect(requests).toEqual([token ?? undefined, "new"]);
    expect(prompts).toBe(1);
  }
});

test("failed retry cannot loop; non-authentication errors never prompt", async () => {
  for (const status of [401, 403, 429, 500]) {
    let requests = 0, prompts = 0;
    await expect(reviewWithSession({ token: null,
      request: async () => { requests++; throw new ApiError("rejected", status, null); },
      authenticate: async () => { prompts++; return "new"; }, assertCurrent() {},
    })).rejects.toThrow("rejected");
    expect(requests).toBe(status === 401 ? 2 : 1);
    expect(prompts).toBe(status === 401 ? 1 : 0);
  }
});

test("wallet rejection and changed action context stop recovery", async () => {
  for (const mode of ["rejected", "before", "after"]) {
    let requests = 0, prompts = 0, checks = 0;
    await expect(reviewWithSession({ token: null,
      request: async () => { requests++; throw new ApiError("Sign in", 401, null); },
      authenticate: async () => { prompts++; if (mode === "rejected") throw new Error("stopped"); return "new"; },
      assertCurrent() { checks++; if ((mode === "before" && checks === 1) || (mode === "after" && checks === 2)) throw new Error("stopped"); },
    })).rejects.toThrow("stopped");
    expect(requests).toBe(1);
    expect(prompts).toBe(mode === "before" ? 0 : 1);
  }
});
