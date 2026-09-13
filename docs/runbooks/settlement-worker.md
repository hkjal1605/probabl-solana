# Settlement-worker retirement

The protocol-owned matcher and settlement-worker were removed on 2026-09-08.
Do not start the old services, assign their roles, provision signing keys or deploy their endpoints.

Use [permissionless atomic placement](../architecture/atomic-placement.md):
the API finds candidates, the owner wallet broadcasts one placement transaction, and the
contract verifies and settles all legs atomically. The onchain `ConditionalSettlement`
contract remains; it is not a backend worker.

For a fresh deployment follow [internal mainnet testing](internal-mainnet-testing.md).
For a development database containing old operational tables, stop old processes, back up
desired history and follow [the guarded migration procedure](shared-postgres.md).
Pending legacy trading work deliberately blocks migration; it must be reconciled or the
old database archived separately. Do not erase or force pending broadcasts to terminal states.
