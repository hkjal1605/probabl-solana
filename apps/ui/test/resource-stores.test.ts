import { expect, test } from "bun:test";
import { createResourceStore } from "../src/stores/createResourceStore";
import { fetchResource } from "../src/utils/fetchResource";

test("concurrent consumers share one read and preserve last-known data on failure", async () => {
  const resource = createResourceStore<string[]>("test-resources");
  let calls = 0;
  const read = async () => {
    calls++;
    return ["market"];
  };
  await Promise.all([fetchResource(resource, "a", read), fetchResource(resource, "a", read)]);
  expect(calls).toBe(1);
  await fetchResource(
    resource,
    "a",
    async () => {
      throw new Error("offline");
    },
    true,
  );
  expect(resource.get("a").data).toEqual(["market"]);
  expect(resource.get("a").error?.message).toBe("offline");
  expect(resource.get("b").data).toBeUndefined();
  await fetchResource(resource, "a", read, true);
  expect(resource.get("a").error).toBeNull();
});
test("late HTTP cannot overwrite newer SSE data or repopulate a cleared wallet store", async () => {
  for (const reset of [true, false]) {
    const resource = createResourceStore<string>("test-races");
    let resolve!: (value: string) => void;
    const pending = fetchResource(
      resource,
      "wallet",
      () =>
        new Promise<string>((done) => {
          resolve = done;
        }),
    );
    if (reset) resource.reset();
    else resource.setData("wallet", "new SSE");
    resolve("old HTTP");
    await pending;
    expect(resource.get("wallet").data).toBe(reset ? undefined : "new SSE");
    expect(resource.get("wallet").loading).toBe(false);
  }
});
