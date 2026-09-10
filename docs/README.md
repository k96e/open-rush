# OpenRush Documentation

## Quick Start

```bash
git clone https://github.com/kanyun-rush/open-rush.git
cd open-rush
pnpm install
docker compose -f docker/docker-compose.dev.yml up -d
pnpm build
pnpm dev
```

## Architecture

See [AGENTS.md](../AGENTS.md) for the full architecture guide.

### Three-Layer Architecture

```
Browser → apps/web (Next.js) → apps/control-worker (pg-boss) → apps/agent-worker (Hono)
                                                                       │
                                                     Claude Code CLI ──┴──▶ apps/llm-router (:8790) ──▶ provider
```

`apps/llm-router` is an **optional** fourth service that all LLM calls funnel through:
provider keys live in that one process, every call is metered, budgets and rate limits are
enforceable. With `LLM_ROUTER_BASE_URL` unset, everything behaves exactly as before.
See [llm-router.md](./llm-router.md).

### Packages

| Package | Purpose |
|---------|---------|
| contracts | Zod schemas + enums + state machine |
| db | Drizzle ORM schema + PostgreSQL |
| control-plane | Business logic services |
| sandbox | SandboxProvider interface |
| agent-runtime | Budget, retry, rate limiting |
| stream | Redis-backed SSE |
| observability | Logging + OTEL |
| integrations | S3 storage |
| skills | reskill-based skill management |
| mcp | MCP server registry |
| memory | pgvector + hybrid search |
| llm-router | Model catalog, sealed-box credentials, per-call metering, budget/rate gates, protocol translation |

## Guides

| Doc | What it covers |
|-----|----------------|
| [quickstart.md](./quickstart.md) | Get an instance running and stream a live Agent run |
| [api.md](./api.md) | Endpoint reference, auth, SSE protocol |
| [llm-router.md](./llm-router.md) | Gateway deployment, key generation & rotation, catalog config, troubleshooting |
| [llm-router-acceptance.md](./llm-router-acceptance.md) | Gateway acceptance evidence (A1–A11) with the trade-offs spelled out |
| [roadmap.md](./roadmap.md) | Milestones and what is still open |

## Contributing

See [CONTRIBUTING.md](../CONTRIBUTING.md).
