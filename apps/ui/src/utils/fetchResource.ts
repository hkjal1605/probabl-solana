import type { ResourceStore } from "@/stores/createResourceStore";

/** Deduplicate shared reads; reset or SSE writes invalidate any older HTTP response. */
export async function fetchResource<T>(
  resource: ResourceStore<T>,
  key: string,
  read: (signal: AbortSignal) => Promise<T>,
  force = false,
) {
  const previous = resource.pending.get(key);
  if (previous) return previous.promise;
  const entry = resource.get(key);
  if (!force && entry.data !== undefined && !entry.error && Date.now() - entry.updatedAt < 10_000)
    return;
  const controller = new AbortController(),
    generation = resource.generation(),
    revision = entry.revision;
  resource.patch(key, { loading: true });
  const run = async () => {
    try {
      const data = await read(controller.signal);
      if (
        !controller.signal.aborted &&
        generation === resource.generation() &&
        resource.get(key).revision === revision
      )
        resource.setData(key, data);
    } catch (error) {
      if (
        !controller.signal.aborted &&
        generation === resource.generation() &&
        resource.get(key).revision === revision
      )
        resource.patch(key, {
          error: error instanceof Error ? error : new Error("Data unavailable"),
          loading: false,
          updatedAt: Date.now(),
        });
    } finally {
      if (resource.pending.get(key)?.controller === controller) resource.pending.delete(key);
    }
  };
  const promise = run();
  resource.pending.set(key, { controller, promise });
  await promise;
}
