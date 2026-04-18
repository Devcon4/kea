# ADR-008: SQLite for Persistence

**Status**: Accepted

## Context

Kea agents need to persist sitemaps (discovered pages, links, visit status) and findings (bugs, issues, anomalies found during testing). This data is per-pod — each agent worker operates independently.

## Decision

Use SQLite via `better-sqlite3` for all agent-side persistence. The database stores:

- **sitemap** table: URL, title, outbound links, visit status, timestamps.
- **findings** table: URL, agent ID, action taken, result, severity, timestamp.

WAL mode is enabled for concurrent read performance.

## Alternatives Considered

- **PostgreSQL**: Full relational database. Overkill for per-pod storage. Would require a shared database deployment, connection pooling, and network hops for every query. Reserved as an upgrade path if cross-pod data sharing becomes necessary.
- **Drizzle ORM + SQLite**: Adds a query builder layer. Our queries are simple enough that raw prepared statements via better-sqlite3 are clearer and have zero abstraction overhead.
- **LevelDB/RocksDB**: Key-value stores. Our data is relational (pages have links, findings reference pages). SQL queries (aggregations, filtering by severity) are more natural.
- **In-memory only**: Would lose all data on pod restart. SQLite provides durability with minimal overhead.

## Consequences

- Zero-dependency persistence — no external database process to manage per pod.
- better-sqlite3 is synchronous, which simplifies the code (no async query overhead in a single-writer scenario) and wraps cleanly in `tryCatchSync`.
- In Kubernetes with readonlyFS, the SQLite database file must be stored on an `emptyDir` or `tmpfs` volume mount. Data is ephemeral per pod lifecycle — this is acceptable since findings are reported to the operator.
- If we later need cross-pod data sharing, we can add a PostgreSQL aggregation layer without changing the per-pod SQLite store.
- WAL mode enables concurrent readers (multiple agent threads reading sitemap) while a single writer updates state.
