import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page renders from the in-browser protocol model with uncached live reads.
// No ISR/data-cache persistence, R2, KV, D1 or Durable Objects are needed.
export default defineCloudflareConfig({
  incrementalCache: "dummy",
  tagCache: "dummy",
  queue: "dummy",
  enableCacheInterception: false,
});
