# ADR-011 — TypeScript matcher for v1

Status: Accepted

## Context

The v1 matcher consumes confirmed chain events and proposes bounded onchain fills. Its throughput
requirement is tied to chain order and settlement capacity, not colocated high-frequency trading.
The repository already standardizes Bun and strict TypeScript for services.

## Decision

Implement the v1 matching state machine in strict TypeScript on Bun. Keep the core synchronous,
integer-only, deterministic, free of network/storage/clock access, and isolated in
`packages/orderbook`. Run one state machine per process and partition books across OS processes
when needed.

Use a structurally independent slow reference matcher as the production shadow. Keep persistence,
leases, event consumption, and settlement handoff outside the core.

## Alternatives

Rust, C++, Java, and Bun worker-thread sharding were considered. Rust is the preferred migration
target if measured event or proposal latency breaches an agreed service-level objective after
profiling. A language rewrite before that evidence would increase operational and cross-language
serialization risk.

## Consequences

V1 shares schemas, tooling, and operational expertise with the rest of the service code. `bigint`
and canonical serialization are mandatory; JavaScript `number`, wall-clock time, random values,
and unordered external inputs are forbidden in matching decisions.

The package includes a reproducible benchmark, but benchmark output is not an SLA and is not
comparable to native-engine benchmarks that exclude journaling, validation, or network work.

## Security assumptions

TypeScript memory safety does not prove algorithmic correctness. Release still requires independent
review, long-running randomized tests, testnet fault injection, and monitoring of shadow divergence.
The contracts independently enforce collateral, signed limits, maker price, and fill quantities.

## Reversal cost

The canonical event, checkpoint, proposal, and fairness formats are language-neutral. A Rust engine
can replay the same golden fixtures and run in shadow before it replaces the TypeScript engine.
