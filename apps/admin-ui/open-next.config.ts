import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Admin pages use uncached live reads. The deployment needs no persistent
// OpenNext cache, queue, R2, KV, D1, or Durable Object bindings.
export default defineCloudflareConfig({
  incrementalCache: "dummy",
  tagCache: "dummy",
  queue: "dummy",
  enableCacheInterception: false,
});
