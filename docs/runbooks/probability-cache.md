# Cached Polymarket display probabilities

The browser does not call Polymarket. The ingestor reads Polymarket; the API
serves the saved market metadata and cached probability observations.

- `GET /v1/markets/:id/probability`: existing local market-ID endpoint, now cached.
- `GET /v1/markets/:id/polymarket`: metadata plus the same cached probability.
- `GET /v1/probabilities/:conditionId/stream`: API-owned SSE used by the UI.

Redis keys include the Solana deployment namespace and canonical Polymarket
condition ID. All local assets created from the same slug/condition reuse the
same probability key. TTL is 60 seconds, set atomically; reads do not renew it.
The API coalesces concurrent misses within a process. Redis failures fall back
to fresh ingestor reads; failed source reads are not cached or served as successes.

Set `REDIS_URL=redis://127.0.0.1:6379` in the API environment (the default).
Use Redis 7.2 or newer with Bun's native client. Keep Redis private/loopback-only;
use authentication/TLS for a remote Redis service. Configure a bounded Redis
memory limit and an eviction policy appropriate for an advisory cache.
Do not expose REDIS_URL as a NEXT_PUBLIC variable.

Deploy the API and UI together, and reload the updated
`ops/ec2/solana/nginx.conf` so SSE is unbuffered. Existing environments need the
Redis service running; the stage-env script now carries REDIS_URL into new API
environments. This change does not install Redis or restart EC2 automatically.

SSE carries a cached observation every minute and heartbeats every 15 seconds.
The browser shares one stream per condition and closes it on final unsubscribe.
The original observation timestamp and source quality remain unchanged. Only
this cached UI display allows 90 seconds of age (30s source window + 60s TTL).
Non-valid or expired observations still display no usable probability. Backend
trading, market-making, evidence, and settlement validation are unchanged.
