# PostgreSQL Monitor

A real-time web-based monitoring dashboard for PostgreSQL. No external monitoring infrastructure required — just Node.js and a database connection.

![PostgreSQL Monitor](https://img.shields.io/badge/PostgreSQL-Monitor-336791?style=flat&logo=postgresql)


<img width="1062" height="798" alt="Topology View" src="https://github.com/user-attachments/assets/87728dec-d922-4ab1-b49f-01630f83d0ab" />


---

## Features

- **Dashboard** — server info, trend sparklines, XID wraparound risk, health checks with fix actions, long-running queries, blocking chains
- **Databases** — per-database stats, size, cache hit ratio, deadlocks, temp usage
- **Active Queries** — live view of running queries with optional idle connections
- **Locks** — current lock holders and waiters
- **Connections** — summary and detail breakdown by state/user/database
- **Tables** — statistics, bloat estimation, sequence health, I/O stats
- **Indexes** — usage stats, invalid indexes, duplicate index detection
- **Slow Queries** — top queries by total time via `pg_stat_statements`, function stats
- **Replication** — WAL archiver, streaming replication status, slots, standby conflicts
- **Internals** — WAL/checkpoint stats, buffer cache breakdown, non-default config
- **Topology** — visual overview of all databases grouped by health status with live query activity animations
- **Health Actions** — one-click fix actions (vacuum, analyze, terminate idle connections, etc.) with SQL preview and streaming progress
- **Index Advisor** — per-table analysis with column types, existing indexes, top queries, and CREATE INDEX suggestions
- **Recommendations** — automated suggestions for missing indexes, bloated tables, stale statistics, and more

---

## Requirements

- **Node.js** 18 or higher
- **PostgreSQL** 12 or higher
- The connecting user needs read access to system catalogs. Superuser or a monitoring role works best (see [Database Permissions](#database-permissions) below).

---

## Quick Start

```bash
# 1. Clone or copy the project
git clone <repo-url> postgres-monitor
cd postgres-monitor

# 2. Install dependencies
npm install

# 3. Configure your database connection
cp .env.example .env
# Edit .env with your connection details

# 4. Start the server
npm start
```

Open **http://localhost:3000** in your browser.

For development with auto-restart on file changes:

```bash
npm run dev
```

---

## Configuration

All configuration is via environment variables. Copy `.env.example` to `.env` and set:

| Variable | Default | Description |
|---|---|---|
| `PG_HOST` | `localhost` | PostgreSQL host |
| `PG_PORT` | `5432` | PostgreSQL port |
| `PG_USER` | `postgres` | Database user |
| `PG_PASSWORD` | _(empty)_ | Database password |
| `PG_DATABASE` | `postgres` | Default database to connect to |
| `PORT` | `3000` | Port the web server listens on |

**Example `.env`:**
```env
PG_HOST=localhost
PG_PORT=5432
PG_USER=postgres
PG_PASSWORD=secret
PG_DATABASE=postgres
PORT=3000
```

---

## Database Permissions

The app connects as a single user and queries system catalogs. For a dedicated read-only monitoring role:

```sql
-- Create a monitoring role
CREATE ROLE pg_monitor_user WITH LOGIN PASSWORD 'yourpassword';

-- Grant access to system monitoring views
GRANT pg_monitor TO pg_monitor_user;

-- Required for pg_stat_statements (slow query tab)
GRANT EXECUTE ON FUNCTION pg_stat_statements_reset() TO pg_monitor_user;
```

> **Note:** The `pg_monitor` built-in role (PostgreSQL 10+) covers most system views. Health fix actions (terminate/cancel backends, VACUUM, ANALYZE) require superuser or appropriate grants.

### For full functionality including fix actions

```sql
-- Allow terminating/cancelling backends
GRANT pg_signal_backend TO pg_monitor_user;

-- VACUUM and ANALYZE require table ownership or superuser
-- Grant superuser only on trusted internal networks
ALTER ROLE pg_monitor_user SUPERUSER;
```

### Enable pg_stat_statements (required for Slow Queries tab)

```sql
-- Add to postgresql.conf:
shared_preload_libraries = 'pg_stat_statements'

-- Then restart PostgreSQL and run:
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
```

---

## Accessing From Another Device

By default the server only listens on `localhost`. To access from another machine or phone on the same network:

1. Find your machine's local IP:
   - **Windows:** `ipconfig` — look for IPv4 Address
   - **macOS/Linux:** `ip addr` or `ifconfig`

2. Open port 3000 in your firewall:
   ```bash
   # Windows (run as Administrator)
   netsh advfirewall firewall add rule name="PG Monitor" dir=in action=allow protocol=TCP localport=3000

   # Linux (ufw)
   ufw allow 3000/tcp
   ```

3. Navigate to `http://<your-ip>:3000` on the other device.

**For temporary remote access** (outside your network), use ngrok:

```bash
npx ngrok http 3000
```

This generates a public HTTPS URL. Close it when done — anyone with the URL can reach your database monitor.

---

## Project Structure

```
postgres-monitor/
├── server.js          # Express server, all API endpoints, PostgreSQL queries
├── public/
│   ├── index.html     # Single-page app shell and tab layout
│   ├── app.js         # All frontend logic, rendering, and API calls
│   └── style.css      # Styles (CSS variables, dark-friendly, responsive)
├── .env               # Local config (not committed)
├── .env.example       # Config template
└── package.json
```

---

## Architecture

### Backend (`server.js`)

**Connection pooling** — `PoolManager` maintains up to 10 per-database `pg` pools (max 3 connections each). The default database uses a dedicated pool of 5. Idle pools are evicted after 60 seconds.

**Query helpers:**
- `query(sql, params)` — runs against the default/global pool
- `queryDb(dbName, sql, params)` — runs against a per-database pool

**In-memory caching** — a simple TTL cache (`apiCache`) wraps expensive endpoints:
- `/api/server-info` — 10s TTL
- `/api/recommendations` — 15s TTL

**RecentQueryTracker** — polls `pg_stat_activity` every 3 seconds to detect query completions. Uses two methods:
1. Tracks active PIDs between polls to detect `active → idle` transitions
2. Detects fast queries (sub-3s) by checking `state_change` on idle backends

Completed queries are stored in a 5-minute ring buffer per database, deduplicated by `pid:query_start`.

**SSE streaming** — health fix actions (`POST /api/health-action/:action`) stream per-step progress using Server-Sent Events so the UI updates in real time.

### Frontend (`public/app.js`)

- Vanilla JavaScript, no framework or build step
- Auto-refresh via `setInterval` (configurable: off / 5s / 10s / 30s / 60s)
- All user-facing strings are XSS-safe via `esc()` (uses `textContent`, never `innerHTML` with raw data)
- Topology live activity updates run on a separate 3s polling loop independent of the main refresh

---

## API Reference

All endpoints return JSON unless noted. Pass `?db=dbname` to target a specific database where supported.

| Method | Endpoint | Description |
|---|---|---|
| GET | `/api/server-info` | PostgreSQL version, uptime, config summary |
| GET | `/api/database-names` | List of all non-template database names |
| GET | `/api/databases` | Per-database stats (size, connections, cache hit, deadlocks) |
| GET | `/api/active-queries` | Running and idle connections from `pg_stat_activity` |
| GET | `/api/locks` | Current lock holders and waiters |
| GET | `/api/blocking` | Blocking chains (who is blocking whom) |
| GET | `/api/connections` | Connection counts grouped by state and user |
| GET | `/api/long-queries` | Queries running longer than 5 seconds |
| GET | `/api/slow-queries` | Top queries by total time from `pg_stat_statements` |
| GET | `/api/table-stats` | `pg_stat_user_tables` — scans, tuples, maintenance times |
| GET | `/api/table-bloat` | Bloat estimation via page-level heuristics |
| GET | `/api/table-io` | Heap and index I/O hit ratios per table |
| GET | `/api/index-stats` | Index size, scans, and usage ratios |
| GET | `/api/invalid-indexes` | Indexes where `indisvalid = false` |
| GET | `/api/duplicate-indexes` | Indexes sharing identical column sets |
| GET | `/api/sequences` | Sequence usage percentage and exhaustion risk |
| GET | `/api/txid-wraparound` | XID age per database and table |
| GET | `/api/replication` | Streaming replication lag and state |
| GET | `/api/replication-slots` | Replication slot retention and lag |
| GET | `/api/wal-archiver` | WAL archiver status and failure info |
| GET | `/api/wal-checkpoint` | Checkpoint frequency, WAL stats, `pg_stat_bgwriter` |
| GET | `/api/buffer-cache` | Buffer usage breakdown by object type |
| GET | `/api/function-stats` | Function/procedure call and time stats |
| GET | `/api/db-conflicts` | Standby conflict counts per database |
| GET | `/api/config-tracking` | Non-default configuration settings |
| GET | `/api/health` | 12 health checks with status, hints, and available actions |
| GET | `/api/recommendations` | Automated recommendations (indexes, bloat, maintenance) |
| GET | `/api/topology` | All databases with health dot, stats, and issues |
| GET | `/api/topology-activity` | Lightweight active/recent query counts per database |
| GET | `/api/db-queries/:dbName` | Running and recent queries for one database |
| GET | `/api/metric-history` | In-memory time-series for sparkline charts |
| GET | `/api/index-advisor/:schema/:table` | Column info, indexes, top queries, and index suggestions |
| GET | `/api/health-action/:action/preview` | SQL preview and targets for a fix action |
| POST | `/api/health-action/:action` | Execute a fix action (SSE stream) |
| POST | `/api/cancel/:pid` | Cancel a query by backend PID |
| POST | `/api/terminate/:pid` | Terminate a backend by PID |

**Available health actions:** `terminate-idle`, `cancel-long-queries`, `terminate-idle-tx`, `analyze-tables`, `vacuum-tables`, `vacuum-freeze`, `drop-inactive-slots`, `reset-stats`

---

## Security Notes

- **No authentication is built in.** Run behind a VPN, SSH tunnel, or reverse proxy with auth (nginx, Caddy) before exposing to any network.
- HTTP security headers are set via [Helmet](https://helmetjs.github.io/).
- Rate limiting: 300 requests/minute per IP.
- All SQL uses parameterized queries (`$1`, `$2`). SQL identifiers (schema/table names) are escaped via `quoteIdent()`.
- PID parameters are validated as positive integers before use.
- Schema and table name parameters are validated against `^[a-zA-Z_][a-zA-Z0-9_]{0,62}$`.

---

## Troubleshooting

**"Cannot connect to database"**
- Check `.env` credentials
- Ensure PostgreSQL is running and accepting connections on the configured host/port
- Check `pg_hba.conf` allows the user to connect

**Slow Queries tab shows nothing**
- `pg_stat_statements` extension must be installed and loaded — see [Database Permissions](#database-permissions)

**Tables / Indexes tabs show no data**
- The connected user may lack access to `pg_stat_user_tables` / `pg_stat_user_indexes`
- Grant the `pg_monitor` role to your user

**Health actions fail with "permission denied"**
- VACUUM and ANALYZE require table ownership or superuser
- Terminate/cancel requires `pg_signal_backend` role or superuser

**Port already in use**
```bash
# Find what's using port 3000
# Windows:
netstat -ano | findstr :3000
# macOS/Linux:
lsof -i :3000

# Then change the PORT in .env
```
