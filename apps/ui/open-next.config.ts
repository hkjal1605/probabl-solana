import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// All application pages depend on the mode cookie and use uncached live reads.
// No ISR/data-cache persistence, R2, KV, D1 or Durable Objects are needed.
export default defineCloudflareConfig({
  incrementalCache: "dummy",
  tagCache: "dummy",
  queue: "dummy",
  enableCacheInterception: false,
});
