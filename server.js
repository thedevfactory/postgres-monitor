require('dotenv').config();
const express = require('express');
const crypto = require('crypto');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// ═══════════════════════════════════════════════════════════════════
// Security middleware
// ═══════════════════════════════════════════════════════════════════
app.use(helmet({ contentSecurityPolicy: false }));
app.use(rateLimit({ windowMs: 60_000, max: 300, standardHeaders: true, legacyHeaders: false }));
app.use(express.json());

// Simple in-memory cache for expensive endpoints
const apiCache = new Map();
function cached(key, ttlMs, fn) {
  return async (req, res) => {
    const cacheKey = key + (req.query.db || '');
    const entry = apiCache.get(cacheKey);
    if (entry && Date.now() - entry.ts < ttlMs) return res.json(entry.data);
    try {
      const data = await fn(req);
      apiCache.set(cacheKey, { data, ts: Date.now() });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  };
}

// ═══════════════════════════════════════════════════════════════════
// Pool Manager — dynamic per-database connection pools
// ═══════════════════════════════════════════════════════════════════
const baseConfig = {
  host: process.env.PG_HOST || 'localhost',
  port: parseInt(process.env.PG_PORT || '5432'),
  user: process.env.PG_USER || 'postgres',
  password: process.env.PG_PASSWORD || '',
};
const defaultDbName = process.env.PG_DATABASE || 'postgres';

const defaultPool = new Pool({
  ...baseConfig,
  database: defaultDbName,
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

class PoolManager {
  constructor(maxPools = 10) {
    this.pools = new Map(); // dbName -> { pool, lastUsed }
    this.maxPools = maxPools;
    this.creating = new Map(); // dbName -> Promise (dedup concurrent creates)
    // Evict idle pools every 60s
    this.cleanupTimer = setInterval(() => this._cleanup(), 60000);
  }

  async getPool(dbName) {
    if (!dbName || dbName === defaultDbName) return defaultPool;

    // Return existing pool
    const entry = this.pools.get(dbName);
    if (entry) {
      entry.lastUsed = Date.now();
      return entry.pool;
    }

    // Deduplicate concurrent creation for same db
    if (this.creating.has(dbName)) return this.creating.get(dbName);

    const promise = this._createPool(dbName);
    this.creating.set(dbName, promise);
    try {
      return await promise;
    } finally {
      this.creating.delete(dbName);
    }
  }

  async _createPool(dbName) {
    // Validate db name exists
    const check = await query(`SELECT 1 FROM pg_database WHERE datname = $1 AND datistemplate = false`, [dbName]);
    if (check.length === 0) throw new Error(`Database "${dbName}" not found`);

    // Evict oldest if at capacity
    if (this.pools.size >= this.maxPools) {
      let oldest = null, oldestTime = Infinity;
      for (const [name, entry] of this.pools) {
        if (entry.lastUsed < oldestTime) { oldest = name; oldestTime = entry.lastUsed; }
      }
      if (oldest) {
        await this.pools.get(oldest).pool.end().catch(() => {});
        this.pools.delete(oldest);
      }
    }

    const pool = new Pool({
      ...baseConfig,
      database: dbName,
      max: 3,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    });
    this.pools.set(dbName, { pool, lastUsed: Date.now() });
    return pool;
  }

  _cleanup() {
    const cutoff = Date.now() - 5 * 60 * 1000; // 5 min idle
    for (const [name, entry] of this.pools) {
      if (entry.lastUsed < cutoff) {
        entry.pool.end().catch(() => {});
        this.pools.delete(name);
      }
    }
  }

  async drainAll() {
    clearInterval(this.cleanupTimer);
    for (const [, entry] of this.pools) {
      await entry.pool.end().catch(() => {});
    }
    this.pools.clear();
    await defaultPool.end().catch(() => {});
  }
}

const poolManager = new PoolManager(10);

// Graceful shutdown
process.on('SIGTERM', () => poolManager.drainAll().then(() => process.exit(0)));
process.on('SIGINT', () => poolManager.drainAll().then(() => process.exit(0)));

app.use(express.static(path.join(__dirname, 'public')));

// ─── Helpers ───────────────────────────────────────────────────────
// Default pool query (server-wide queries)
async function query(sql, params) {
  const client = await defaultPool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

// Database-specific query
async function queryDb(dbName, sql, params) {
  const pool = await poolManager.getPool(dbName);
  const client = await pool.connect();
  try {
    const result = await client.query(sql, params);
    return result.rows;
  } finally {
    client.release();
  }
}

// Validate and extract ?db= param
function getDbParam(req) {
  const db = req.query.db;
  if (!db) return null;
  if (!/^[a-zA-Z0-9_\-. ]+$/.test(db)) throw new Error('Invalid database name');
  return db;
}

let pgVersionNum = null;
async function getPgVersion() {
  if (pgVersionNum) return pgVersionNum;
  const rows = await query("SELECT current_setting('server_version_num')::int AS v");
  pgVersionNum = rows[0].v;
  return pgVersionNum;
}

// ─── Metric History (in-memory ring buffer) ────────────────────────
class MetricHistory {
  constructor(maxPoints = 60) {
    this.maxPoints = maxPoints;
    this.series = {};
  }
  push(name, value) {
    if (!this.series[name]) this.series[name] = [];
    const arr = this.series[name];
    arr.push({ ts: Date.now(), value });
    if (arr.length > this.maxPoints) arr.shift();
  }
  getAll() { return this.series; }
}
const history = new MetricHistory(60);

// ─── Recent Query Tracker ─────────────────────────────────────────
class RecentQueryTracker {
  constructor(retentionMs = 300000, pollMs = 3000, maxEntries = 10000) {
    this.retentionMs = retentionMs;
    this.pollMs = pollMs;
    this.maxEntries = maxEntries;
    this.previous = new Map();   // pid -> snapshot row from last poll
    this.running = new Map();    // pid -> query record (currently active)
    this.recent = [];            // completed queries (ring buffer)
    this.seen = new Set();       // dedup keys: "pid:query_start" for recently captured
    this.timer = setInterval(() => this.poll(), pollMs);
    this.poll();
  }
  _dedup(pid, query_start) {
    const key = `${pid}:${query_start}`;
    if (this.seen.has(key)) return true;
    this.seen.add(key);
    return false;
  }
  async poll() {
    try {
      const rows = await query(`
        SELECT pid, datname, usename, state, query, query_start, state_change,
               wait_event_type, wait_event, client_addr, application_name,
               EXTRACT(EPOCH FROM (now() - query_start)) AS duration_secs,
               EXTRACT(EPOCH FROM (now() - state_change)) AS since_state_change
        FROM pg_stat_activity
        WHERE pid != pg_backend_pid() AND datname IS NOT NULL
      `);
      const now = Date.now();
      const currentPids = new Set();

      for (const r of rows) {
        currentPids.add(r.pid);
        if (r.state === 'active' && r.query) {
          this.running.set(r.pid, {
            pid: r.pid, datname: r.datname, usename: r.usename,
            query: r.query, query_start: r.query_start,
            duration_secs: parseFloat(r.duration_secs || 0),
            wait_event_type: r.wait_event_type, wait_event: r.wait_event,
            client_addr: r.client_addr, application_name: r.application_name,
          });
        } else {
          this.running.delete(r.pid);

          // Capture completed queries via two methods:
          // 1) Transition: was active in previous poll, now idle
          const prev = this.previous.get(r.pid);
          if (prev && prev.state === 'active' && r.state !== 'active' && prev.query) {
            if (!this._dedup(r.pid, prev.query_start)) {
              this.recent.push({
                pid: r.pid, datname: prev.datname, usename: prev.usename,
                query: prev.query, query_start: prev.query_start,
                completed_at: r.state_change || new Date().toISOString(),
                duration_ms: r.state_change && prev.query_start
                  ? new Date(r.state_change) - new Date(prev.query_start) : null,
                client_addr: prev.client_addr, application_name: prev.application_name,
                ts: now,
              });
            }
          }

          // 2) Fast query: backend is idle but state_change is recent (within poll interval)
          //    and query_start exists — this catches queries that started AND finished between polls
          const sinceSecs = parseFloat(r.since_state_change || 999);
          if (r.state === 'idle' && r.query && r.query_start && sinceSecs < (this.pollMs / 1000 + 1)) {
            if (!this._dedup(r.pid, r.query_start)) {
              this.recent.push({
                pid: r.pid, datname: r.datname, usename: r.usename,
                query: r.query, query_start: r.query_start,
                completed_at: r.state_change || new Date().toISOString(),
                duration_ms: r.state_change && r.query_start
                  ? new Date(r.state_change) - new Date(r.query_start) : null,
                client_addr: r.client_addr, application_name: r.application_name,
                ts: now,
              });
            }
          }
        }
        this.previous.set(r.pid, { state: r.state, datname: r.datname, usename: r.usename,
          query: r.query, query_start: r.query_start, client_addr: r.client_addr,
          application_name: r.application_name });
      }

      // PIDs that disappeared — mark as completed if they were active
      for (const [pid, prev] of this.previous) {
        if (!currentPids.has(pid)) {
          if (prev.state === 'active' && prev.query) {
            if (!this._dedup(pid, prev.query_start)) {
              this.recent.push({
                pid, datname: prev.datname, usename: prev.usename,
                query: prev.query, query_start: prev.query_start,
                completed_at: new Date().toISOString(), duration_ms: null,
                client_addr: prev.client_addr, application_name: prev.application_name,
                ts: now,
              });
            }
          }
          this.running.delete(pid);
          this.previous.delete(pid);
        }
      }

      // Evict old entries and dedup keys
      const cutoff = now - this.retentionMs;
      this.recent = this.recent.filter(r => r.ts > cutoff);
      if (this.recent.length > this.maxEntries) {
        this.recent = this.recent.slice(-this.maxEntries);
      }
      // Rebuild seen set from current recent entries to prevent unbounded growth
      this.seen = new Set(this.recent.map(r => `${r.pid}:${r.query_start}`));
    } catch {}
  }
  getActivitySummary() {
    const dbs = {};
    for (const r of this.running.values()) {
      if (!dbs[r.datname]) dbs[r.datname] = { active: 0, recent: 0, connections: 0 };
      dbs[r.datname].active++;
    }
    for (const r of this.recent) {
      if (!dbs[r.datname]) dbs[r.datname] = { active: 0, recent: 0, connections: 0 };
      dbs[r.datname].recent++;
    }
    // Connection counts from previous snapshot
    for (const [, r] of this.previous) {
      if (!dbs[r.datname]) dbs[r.datname] = { active: 0, recent: 0, connections: 0 };
      dbs[r.datname].connections++;
    }
    return dbs;
  }
  getByDatabase(dbName) {
    const running = [];
    for (const r of this.running.values()) {
      if (r.datname === dbName) running.push(r);
    }
    const recent = this.recent.filter(r => r.datname === dbName)
      .sort((a, b) => b.ts - a.ts);
    return { running, recent };
  }
}
const queryTracker = new RecentQueryTracker();

async function collectMetrics() {
  try {
    const conn = await query('SELECT count(*) AS cnt FROM pg_stat_activity');
    history.push('connections', parseInt(conn[0].cnt));

    const active = await query("SELECT count(*) AS cnt FROM pg_stat_activity WHERE state = 'active' AND pid != pg_backend_pid()");
    history.push('active_queries', parseInt(active[0].cnt));

    const tps = await query('SELECT sum(xact_commit + xact_rollback) AS total FROM pg_stat_database');
    history.push('total_xacts', parseInt(tps[0].total || 0));

    const cache = await query("SELECT CASE WHEN sum(blks_hit+blks_read)>0 THEN round(sum(blks_hit)::numeric/sum(blks_hit+blks_read)*100,2) ELSE 100 END AS ratio FROM pg_stat_database");
    history.push('cache_hit_ratio', parseFloat(cache[0].ratio));

    const locks = await query('SELECT count(*) AS cnt FROM pg_locks WHERE NOT granted');
    history.push('waiting_locks', parseInt(locks[0].cnt));
  } catch {}
}
setInterval(collectMetrics, 10000);
collectMetrics();

app.get('/api/metric-history', (req, res) => {
  res.json(history.getAll());
});

// ─── Bloat cache (expensive query, per-database, cache 60s) ────────
const bloatCaches = new Map(); // dbName -> { ts, data }

// ─── Config tracking state ─────────────────────────────────────────
const configHistory = [];

// ═══════════════════════════════════════════════════════════════════
// NEW: List available databases (for frontend selector)
// ═══════════════════════════════════════════════════════════════════
app.get('/api/database-names', async (req, res) => {
  try {
    const rows = await query(`
      SELECT datname FROM pg_database
      WHERE datistemplate = false
      ORDER BY datname
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Server Overview ───────────────────────────────────────────────
app.get('/api/server-info', cached('server-info', 10_000, async () => {
  const rows = await query(`
    SELECT
      version() AS version,
      current_setting('server_version') AS server_version,
      pg_postmaster_start_time() AS start_time,
      now() - pg_postmaster_start_time() AS uptime,
      current_setting('max_connections')::int AS max_connections,
      (SELECT count(*) FROM pg_stat_activity) AS current_connections,
      current_setting('shared_buffers') AS shared_buffers,
      current_setting('effective_cache_size') AS effective_cache_size,
      current_setting('work_mem') AS work_mem,
      current_setting('maintenance_work_mem') AS maintenance_work_mem,
      pg_size_pretty(pg_database_size(current_database())) AS current_db_size
  `);
  return rows[0];
}));

// ─── All Databases ─────────────────────────────────────────────────
app.get('/api/databases', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        d.datname AS name,
        pg_size_pretty(pg_database_size(d.datname)) AS size,
        pg_database_size(d.datname) AS size_bytes,
        s.numbackends AS connections,
        s.xact_commit AS commits,
        s.xact_rollback AS rollbacks,
        CASE WHEN (s.xact_commit + s.xact_rollback) > 0
          THEN round(s.xact_rollback::numeric / (s.xact_commit + s.xact_rollback) * 100, 2)
          ELSE 0
        END AS rollback_pct,
        s.blks_read, s.blks_hit,
        CASE WHEN (s.blks_hit + s.blks_read) > 0
          THEN round(s.blks_hit::numeric / (s.blks_hit + s.blks_read) * 100, 2)
          ELSE 0
        END AS cache_hit_ratio,
        s.tup_returned, s.tup_fetched, s.tup_inserted, s.tup_updated, s.tup_deleted,
        s.conflicts, s.deadlocks, s.temp_files,
        pg_size_pretty(s.temp_bytes) AS temp_bytes,
        s.stats_reset
      FROM pg_database d
      JOIN pg_stat_database s ON d.datname = s.datname
      WHERE d.datistemplate = false
      ORDER BY pg_database_size(d.datname) DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Active Queries ────────────────────────────────────────────────
app.get('/api/active-queries', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        pid, usename AS username, datname AS database, client_addr,
        application_name, state, wait_event_type, wait_event, query,
        backend_start, xact_start, query_start,
        now() - query_start AS query_duration,
        now() - xact_start AS xact_duration
      FROM pg_stat_activity
      WHERE state IS NOT NULL AND pid != pg_backend_pid()
      ORDER BY
        CASE WHEN state = 'active' THEN 0 ELSE 1 END,
        query_start ASC NULLS LAST
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Locks ─────────────────────────────────────────────────────────
app.get('/api/locks', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        l.pid, a.usename AS username, a.datname AS database,
        l.locktype, l.mode, l.granted, l.waitstart,
        CASE WHEN l.relation IS NOT NULL THEN l.relation::regclass::text ELSE NULL END AS relation,
        a.query, a.state,
        now() - a.query_start AS duration
      FROM pg_locks l
      JOIN pg_stat_activity a ON l.pid = a.pid
      WHERE a.pid != pg_backend_pid()
      ORDER BY l.granted, l.waitstart ASC NULLS LAST
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Blocking Queries (lock chains) ───────────────────────────────
app.get('/api/blocking', async (req, res) => {
  try {
    const rows = await query(`
      SELECT
        blocked_locks.pid AS blocked_pid,
        blocked_activity.usename AS blocked_user,
        blocked_activity.query AS blocked_query,
        now() - blocked_activity.query_start AS blocked_duration,
        blocking_locks.pid AS blocking_pid,
        blocking_activity.usename AS blocking_user,
        blocking_activity.query AS blocking_query,
        now() - blocking_activity.query_start AS blocking_duration
      FROM pg_locks blocked_locks
      JOIN pg_stat_activity blocked_activity ON blocked_activity.pid = blocked_locks.pid
      JOIN pg_locks blocking_locks
        ON blocking_locks.locktype = blocked_locks.locktype
        AND blocking_locks.database IS NOT DISTINCT FROM blocked_locks.database
        AND blocking_locks.relation IS NOT DISTINCT FROM blocked_locks.relation
        AND blocking_locks.page IS NOT DISTINCT FROM blocked_locks.page
        AND blocking_locks.tuple IS NOT DISTINCT FROM blocked_locks.tuple
        AND blocking_locks.virtualxid IS NOT DISTINCT FROM blocked_locks.virtualxid
        AND blocking_locks.transactionid IS NOT DISTINCT FROM blocked_locks.transactionid
        AND blocking_locks.classid IS NOT DISTINCT FROM blocked_locks.classid
        AND blocking_locks.objid IS NOT DISTINCT FROM blocked_locks.objid
        AND blocking_locks.objsubid IS NOT DISTINCT FROM blocked_locks.objsubid
        AND blocking_locks.pid != blocked_locks.pid
      JOIN pg_stat_activity blocking_activity ON blocking_activity.pid = blocking_locks.pid
      WHERE NOT blocked_locks.granted
      ORDER BY blocked_activity.query_start
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Connection Stats ──────────────────────────────────────────────
app.get('/api/connections', async (req, res) => {
  try {
    const rows = await query(`
      SELECT datname AS database, usename AS username, client_addr, state, count(*) AS count
      FROM pg_stat_activity WHERE pid != pg_backend_pid()
      GROUP BY datname, usename, client_addr, state ORDER BY count DESC
    `);
    const summary = await query(`
      SELECT state, count(*) AS count
      FROM pg_stat_activity WHERE pid != pg_backend_pid()
      GROUP BY state ORDER BY count DESC
    `);
    res.json({ details: rows, summary });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Replication Status ────────────────────────────────────────────
app.get('/api/replication', async (req, res) => {
  try {
    const rows = await query(`
      SELECT client_addr, usename, application_name, state,
        sent_lsn, write_lsn, flush_lsn, replay_lsn,
        sync_state, reply_time
      FROM pg_stat_replication ORDER BY client_addr
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Table Stats (?db= supported) ─────────────────────────────────
app.get('/api/table-stats', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const rows = await queryDb(dbName, `
      SELECT
        schemaname AS schema, relname AS table,
        pg_size_pretty(pg_total_relation_size(relid)) AS total_size,
        pg_total_relation_size(relid) AS total_size_bytes,
        n_live_tup AS live_rows, n_dead_tup AS dead_rows,
        CASE WHEN n_live_tup > 0 THEN round(n_dead_tup::numeric / n_live_tup * 100, 2) ELSE 0 END AS dead_row_pct,
        last_vacuum, last_autovacuum, last_analyze, last_autoanalyze,
        vacuum_count, autovacuum_count,
        seq_scan, seq_tup_read, idx_scan, idx_tup_fetch
      FROM pg_stat_user_tables
      ORDER BY pg_total_relation_size(relid) DESC LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Index Stats (?db= supported) ──────────────────────────────────
app.get('/api/index-stats', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const rows = await queryDb(dbName, `
      SELECT
        s.schemaname AS schema, s.relname AS table, s.indexrelname AS index,
        pg_size_pretty(pg_relation_size(s.indexrelid)) AS index_size,
        pg_relation_size(s.indexrelid) AS index_size_bytes,
        s.idx_scan AS scans, s.idx_tup_read AS tuples_read, s.idx_tup_fetch AS tuples_fetched,
        CASE WHEN s.idx_scan = 0 AND t.n_live_tup > 1000 AND pg_relation_size(s.indexrelid) > 8192
          THEN true ELSE false
        END AS unused
      FROM pg_stat_user_indexes s
      JOIN pg_stat_user_tables t ON s.relid = t.relid
      ORDER BY s.idx_scan ASC, pg_relation_size(s.indexrelid) DESC
      LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Long-running queries ─────────────────────────────────────────
app.get('/api/long-queries', async (req, res) => {
  try {
    const rows = await query(`
      SELECT pid, usename AS username, datname AS database, state, query,
        now() - query_start AS duration, wait_event_type, wait_event
      FROM pg_stat_activity
      WHERE state = 'active' AND pid != pg_backend_pid()
        AND now() - query_start > interval '5 seconds'
      ORDER BY query_start ASC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── pg_stat_statements (?db= supported) ───────────────────────────
app.get('/api/slow-queries', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const ext = await queryDb(dbName, "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'");
    if (ext.length === 0) return res.json({ available: false, rows: [] });
    const rows = await queryDb(dbName, `
      SELECT queryid, query, calls,
        round(total_exec_time::numeric, 2) AS total_time_ms,
        round(mean_exec_time::numeric, 2) AS avg_time_ms,
        round(min_exec_time::numeric, 2) AS min_time_ms,
        round(max_exec_time::numeric, 2) AS max_time_ms,
        rows, shared_blks_hit, shared_blks_read,
        CASE WHEN (shared_blks_hit + shared_blks_read) > 0
          THEN round(shared_blks_hit::numeric / (shared_blks_hit + shared_blks_read) * 100, 2)
          ELSE 0
        END AS cache_hit_ratio
      FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 25
    `);
    res.json({ available: true, rows });
  } catch (err) {
    if (err.message && err.message.includes('shared_preload_libraries')) {
      return res.json({ available: false, rows: [], reason: 'pg_stat_statements must be loaded via shared_preload_libraries' });
    }
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// TIER 1 ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

// ─── XID Wraparound Risk (?db= for tables sub-query) ────────────
app.get('/api/txid-wraparound', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const databases = await query(`
      SELECT
        datname AS database,
        age(datfrozenxid) AS xid_age,
        current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age,
        round(age(datfrozenxid)::numeric / current_setting('autovacuum_freeze_max_age')::bigint * 100, 2) AS pct_towards_wraparound,
        pg_size_pretty(pg_database_size(datname)) AS size
      FROM pg_database WHERE datistemplate = false
      ORDER BY age(datfrozenxid) DESC
    `);
    const tables = await queryDb(dbName, `
      SELECT s.schemaname AS schema, s.relname AS table,
        age(c.relfrozenxid) AS xid_age,
        pg_size_pretty(pg_total_relation_size(s.relid)) AS size,
        s.last_autovacuum
      FROM pg_stat_user_tables s
      JOIN pg_class c ON c.oid = s.relid
      ORDER BY age(c.relfrozenxid) DESC LIMIT 20
    `);
    res.json({ databases, tables });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Sequence Health (?db= supported) ──────────────────────────────
app.get('/api/sequences', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const rows = await queryDb(dbName, `
      SELECT schemaname AS schema, sequencename AS sequence,
        last_value, max_value,
        CASE WHEN max_value > 0
          THEN round((last_value::numeric / max_value) * 100, 2)
          ELSE 0
        END AS pct_used,
        data_type
      FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog', 'information_schema')
      ORDER BY CASE WHEN max_value > 0 THEN last_value::numeric / max_value ELSE 0 END DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WAL & Checkpoint Stats ──────────────────────────────────────
app.get('/api/wal-checkpoint', async (req, res) => {
  try {
    const ver = await getPgVersion();
    let bgwriter, checkpointer;
    if (ver >= 170000) {
      checkpointer = (await query(`
        SELECT num_timed AS checkpoints_timed, num_requested AS checkpoints_req,
          write_time AS checkpoint_write_time, sync_time AS checkpoint_sync_time,
          buffers_written AS buffers_checkpoint, stats_reset
        FROM pg_stat_checkpointer
      `))[0];
      bgwriter = (await query(`
        SELECT buffers_clean, maxwritten_clean, buffers_alloc, stats_reset
        FROM pg_stat_bgwriter
      `))[0];
    } else {
      const row = (await query(`
        SELECT checkpoints_timed, checkpoints_req,
          checkpoint_write_time, checkpoint_sync_time,
          buffers_checkpoint, buffers_clean, maxwritten_clean,
          buffers_backend, buffers_backend_fsync, buffers_alloc, stats_reset
        FROM pg_stat_bgwriter
      `))[0];
      checkpointer = {
        checkpoints_timed: row.checkpoints_timed,
        checkpoints_req: row.checkpoints_req,
        checkpoint_write_time: row.checkpoint_write_time,
        checkpoint_sync_time: row.checkpoint_sync_time,
        buffers_checkpoint: row.buffers_checkpoint,
        stats_reset: row.stats_reset,
      };
      bgwriter = {
        buffers_clean: row.buffers_clean,
        maxwritten_clean: row.maxwritten_clean,
        buffers_alloc: row.buffers_alloc,
        buffers_backend: row.buffers_backend,
        buffers_backend_fsync: row.buffers_backend_fsync,
        stats_reset: row.stats_reset,
      };
    }
    res.json({ checkpointer, bgwriter });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Replication Slots ────────────────────────────────────────────
app.get('/api/replication-slots', async (req, res) => {
  try {
    const ver = await getPgVersion();
    let sql;
    if (ver >= 130000) {
      sql = `SELECT slot_name, plugin, slot_type, active, xmin, catalog_xmin,
        restart_lsn, confirmed_flush_lsn, wal_status, safe_wal_size,
        age(xmin) AS xmin_age, age(catalog_xmin) AS catalog_xmin_age
        FROM pg_replication_slots ORDER BY CASE WHEN active THEN 1 ELSE 0 END, slot_name`;
    } else {
      sql = `SELECT slot_name, plugin, slot_type, active, xmin, catalog_xmin,
        restart_lsn, confirmed_flush_lsn, NULL AS wal_status, NULL AS safe_wal_size,
        age(xmin) AS xmin_age, age(catalog_xmin) AS catalog_xmin_age
        FROM pg_replication_slots ORDER BY CASE WHEN active THEN 1 ELSE 0 END, slot_name`;
    }
    const rows = await query(sql);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── WAL Archiver Stats ──────────────────────────────────────────
app.get('/api/wal-archiver', async (req, res) => {
  try {
    const rows = await query(`
      SELECT archived_count, last_archived_wal, last_archived_time,
        failed_count, last_failed_wal, last_failed_time, stats_reset
      FROM pg_stat_archiver
    `);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Table Bloat Estimation (?db= supported, per-db cache) ────────
app.get('/api/table-bloat', async (req, res) => {
  try {
    const dbName = getDbParam(req) || defaultDbName;
    const cached = bloatCaches.get(dbName);
    if (cached && Date.now() - cached.ts < 60000 && cached.data.length > 0) {
      return res.json(cached.data);
    }
    const rows = await queryDb(dbName === defaultDbName ? null : dbName, `
      SELECT schemaname AS schema, tblname AS table,
        pg_size_pretty(real_size) AS real_size,
        pg_size_pretty(extra_size) AS bloat_size,
        extra_pct AS bloat_pct,
        real_size AS real_size_bytes, extra_size AS bloat_size_bytes
      FROM (
        SELECT current_database(), schemaname, tblname,
          (bs*tblpages)::bigint AS real_size,
          ((tblpages-est_tblpages)*bs)::bigint AS extra_size,
          CASE WHEN tblpages - est_tblpages > 0
            THEN round((100.0 * (tblpages - est_tblpages)/tblpages)::numeric, 2)
            ELSE 0
          END AS extra_pct,
          is_na
        FROM (
          SELECT ceil(reltuples / ((bs-page_hdr)/tpl_size)) + ceil(toasttuples / 4) AS est_tblpages,
            tblpages, bs, schemaname, tblname, is_na
          FROM (
            SELECT
              (4 + tpl_hdr_size + tpl_data_size + (2*ma)
                - CASE WHEN tpl_hdr_size%ma = 0 THEN ma ELSE tpl_hdr_size%ma END
                - CASE WHEN ceil(tpl_data_size)::int%ma = 0 THEN ma ELSE ceil(tpl_data_size)::int%ma END
              ) AS tpl_size,
              heappages + toastpages AS tblpages, heappages, toastpages,
              reltuples, toasttuples, bs, page_hdr, schemaname, tblname, is_na
            FROM (
              SELECT
                ns.nspname AS schemaname, tbl.relname AS tblname,
                tbl.reltuples, tbl.relpages AS heappages,
                coalesce(toast.relpages, 0) AS toastpages,
                coalesce(toast.reltuples, 0) AS toasttuples,
                current_setting('block_size')::numeric AS bs,
                CASE WHEN version()~'mingw32|64-bit|x86_64|ppc64|ia64|amd64' THEN 8 ELSE 4 END AS ma,
                24 AS page_hdr,
                23 + CASE WHEN MAX(coalesce(s.null_frac,0)) > 0 THEN (7 + count(s.attname)) / 8 ELSE 0::int END
                  + CASE WHEN bool_or(att.attname = 'oid' and att.attinhcount = 0) THEN 4 ELSE 0 END AS tpl_hdr_size,
                sum((1-coalesce(s.null_frac, 0)) * coalesce(s.avg_width, 0)) AS tpl_data_size,
                bool_or(att.atttypid = 'pg_catalog.name'::regtype)
                  OR sum(CASE WHEN att.attnum > 0 THEN 1 ELSE 0 END) <> count(s.attname) AS is_na
              FROM pg_attribute AS att
              JOIN pg_class AS tbl ON att.attrelid = tbl.oid
              JOIN pg_namespace AS ns ON ns.oid = tbl.relnamespace
              LEFT JOIN pg_stats AS s ON s.schemaname=ns.nspname AND s.tablename=tbl.relname AND s.inherited=false AND s.attname=att.attname
              LEFT JOIN pg_class AS toast ON tbl.reltoastrelid = toast.oid
              WHERE NOT att.attisdropped AND tbl.relkind in ('r','m')
                AND ns.nspname NOT IN ('pg_catalog','information_schema')
              GROUP BY 1,2,3,4,5,6,7,8,9
            ) AS s
          ) AS s2
        ) AS s3
      ) AS s4
      WHERE NOT is_na AND extra_size > 0
      ORDER BY extra_size DESC NULLS LAST LIMIT 50
    `);
    bloatCaches.set(dbName, { ts: Date.now(), data: rows });
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Buffer Cache Breakdown (?db= supported) ──────────────────────
app.get('/api/buffer-cache', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const ext = await queryDb(dbName, "SELECT 1 FROM pg_extension WHERE extname = 'pg_buffercache'");
    if (ext.length === 0) return res.json({ available: false, rows: [] });
    const rows = await queryDb(dbName, `
      SELECT c.relname AS relation,
        CASE c.relkind WHEN 'r' THEN 'table' WHEN 'i' THEN 'index' WHEN 't' THEN 'toast'
          WHEN 'S' THEN 'sequence' WHEN 'm' THEN 'matview' ELSE c.relkind::text END AS type,
        pg_size_pretty(count(*) * current_setting('block_size')::int) AS buffered_size,
        count(*) AS buffers,
        round((100.0 * count(*) / NULLIF((SELECT count(*) FROM pg_buffercache WHERE relfilenode IS NOT NULL), 0))::numeric, 2) AS pct_of_cache,
        round((100.0 * count(*) FILTER (WHERE b.usagecount > 1) / NULLIF(count(*), 0))::numeric, 2) AS pct_popular
      FROM pg_buffercache b
      JOIN pg_class c ON b.relfilenode = pg_relation_filenode(c.oid)
        AND b.reldatabase IN (0, (SELECT oid FROM pg_database WHERE datname = current_database()))
      GROUP BY c.relname, c.relkind
      ORDER BY count(*) DESC LIMIT 30
    `);
    res.json({ available: true, rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// TIER 2 ENDPOINTS
// ═══════════════════════════════════════════════════════════════════

// ─── Invalid Indexes (?db= supported) ──────────────────────────────
app.get('/api/invalid-indexes', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const rows = await queryDb(dbName, `
      SELECT n.nspname AS schema, c.relname AS table, i.relname AS index,
        pg_size_pretty(pg_relation_size(i.oid)) AS size
      FROM pg_index x
      JOIN pg_class c ON c.oid = x.indrelid
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE NOT x.indisvalid
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Duplicate Indexes (?db= supported) ───────────────────────────
app.get('/api/duplicate-indexes', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const rows = await queryDb(dbName, `
      SELECT n.nspname AS schema, ct.relname AS table,
        array_agg(ci.relname ORDER BY pg_relation_size(ci.oid) DESC) AS index_names,
        array_agg(pg_size_pretty(pg_relation_size(ci.oid)) ORDER BY pg_relation_size(ci.oid) DESC) AS index_sizes,
        pg_size_pretty(sum(pg_relation_size(ci.oid)) - max(pg_relation_size(ci.oid))) AS wasted_size,
        sum(pg_relation_size(ci.oid)) - max(pg_relation_size(ci.oid)) AS wasted_bytes,
        x.indkey::text AS columns
      FROM pg_index x
      JOIN pg_class ct ON ct.oid = x.indrelid
      JOIN pg_class ci ON ci.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = ct.relnamespace
      WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
      GROUP BY n.nspname, ct.relname, x.indkey
      HAVING count(*) > 1
      ORDER BY sum(pg_relation_size(ci.oid)) - max(pg_relation_size(ci.oid)) DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Function/Procedure Stats (?db= supported) ────────────────────
app.get('/api/function-stats', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const rows = await queryDb(dbName, `
      SELECT schemaname AS schema, funcname AS function, calls,
        round(total_time::numeric, 2) AS total_time_ms,
        round(self_time::numeric, 2) AS self_time_ms,
        CASE WHEN calls > 0 THEN round((total_time / calls)::numeric, 2) ELSE 0 END AS avg_time_ms
      FROM pg_stat_user_functions
      ORDER BY total_time DESC LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Database Conflicts (Standby) ────────────────────────────────
app.get('/api/db-conflicts', async (req, res) => {
  try {
    const rows = await query(`
      SELECT datname AS database,
        confl_tablespace, confl_lock, confl_snapshot, confl_bufferpin, confl_deadlock
      FROM pg_stat_database_conflicts
      WHERE datname NOT IN ('template0', 'template1')
      ORDER BY (confl_tablespace + confl_lock + confl_snapshot + confl_bufferpin + confl_deadlock) DESC
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Configuration Tracking ──────────────────────────────────────
app.get('/api/config-tracking', async (req, res) => {
  try {
    const rows = await query(`
      SELECT name, setting, unit, source, boot_val, reset_val
      FROM pg_settings WHERE source != 'default'
      ORDER BY name
    `);
    const hash = crypto.createHash('md5').update(JSON.stringify(rows)).digest('hex');
    const lastEntry = configHistory.length > 0 ? configHistory[configHistory.length - 1] : null;
    const changed = lastEntry ? lastEntry.hash !== hash : false;
    if (!lastEntry || lastEntry.hash !== hash) {
      configHistory.push({ ts: Date.now(), hash });
      if (configHistory.length > 50) configHistory.shift();
    }
    res.json({ settings: rows, hash, changed, history_length: configHistory.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Table I/O Stats (?db= supported) ─────────────────────────────
app.get('/api/table-io', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const rows = await queryDb(dbName, `
      SELECT schemaname AS schema, relname AS table,
        heap_blks_read, heap_blks_hit,
        CASE WHEN (heap_blks_hit + heap_blks_read) > 0
          THEN round(heap_blks_hit::numeric / (heap_blks_hit + heap_blks_read) * 100, 2)
          ELSE 0
        END AS heap_hit_pct,
        idx_blks_read, idx_blks_hit,
        toast_blks_read, toast_blks_hit,
        tidx_blks_read, tidx_blks_hit
      FROM pg_statio_user_tables
      ORDER BY heap_blks_read DESC LIMIT 50
    `);
    res.json(rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ═══════════════════════════════════════════════════════════════════
// TIER 3: RECOMMENDATIONS ENGINE (?db= supported)
// ═══════════════════════════════════════════════════════════════════
// ─── Table Index Advisor ──────────────────────────────────────────
const IDENT_RE = /^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/;

app.get('/api/index-advisor/:schema/:table', async (req, res) => {
  try {
    const dbName = getDbParam(req);
    const schema = req.params.schema;
    const table = req.params.table;

    if (!IDENT_RE.test(schema) || !IDENT_RE.test(table)) {
      return res.status(400).json({ error: 'Invalid schema or table name' });
    }

    // 1. Table columns with types
    const columns = await queryDb(dbName, `
      SELECT a.attname AS column_name, pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
        a.attnotnull AS not_null, a.attnum AS ordinal,
        CASE WHEN pk.contype = 'p' THEN true ELSE false END AS is_primary
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_constraint pk ON pk.conrelid = c.oid AND pk.contype = 'p' AND a.attnum = ANY(pk.conkey)
      WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum
    `, [schema, table]);

    // 2. Existing indexes
    const indexes = await queryDb(dbName, `
      SELECT i.relname AS index_name, ix.indisunique AS is_unique, ix.indisprimary AS is_primary,
        pg_size_pretty(pg_relation_size(i.oid)) AS size,
        pg_get_indexdef(ix.indexrelid) AS definition
      FROM pg_index ix
      JOIN pg_class i ON i.oid = ix.indexrelid
      JOIN pg_class t ON t.oid = ix.indrelid
      JOIN pg_namespace n ON n.oid = t.relnamespace
      WHERE n.nspname = $1 AND t.relname = $2
      ORDER BY pg_relation_size(i.oid) DESC
    `, [schema, table]);

    // 3. Table stats
    const stats = await queryDb(dbName, `
      SELECT seq_scan, seq_tup_read, idx_scan, idx_tup_fetch,
        n_live_tup, n_dead_tup,
        pg_size_pretty(pg_total_relation_size(c.oid)) AS total_size,
        pg_size_pretty(pg_relation_size(c.oid)) AS table_size
      FROM pg_stat_user_tables s
      JOIN pg_class c ON c.oid = s.relid
      WHERE s.schemaname = $1 AND s.relname = $2
    `, [schema, table]);

    // 4. Top queries hitting this table (if pg_stat_statements is available)
    let topQueries = [];
    try {
      const ext = await queryDb(dbName, "SELECT 1 FROM pg_extension WHERE extname = 'pg_stat_statements'");
      if (ext.length > 0) {
        topQueries = await queryDb(dbName, `
          SELECT left(query, 200) AS query, calls, round(mean_exec_time::numeric, 2) AS avg_ms,
            rows AS avg_rows
          FROM pg_stat_statements
          WHERE query ILIKE $1
          ORDER BY calls DESC LIMIT 5
        `, [`%${table}%`]);
      }
    } catch {}

    // 5. Generate suggested indexes based on column analysis
    const suggestions = [];
    const existingCols = new Set();
    for (const idx of indexes) {
      // Extract column names from index definition
      const match = idx.definition.match(/\(([^)]+)\)/);
      if (match) match[1].split(',').forEach(c => existingCols.add(c.trim().replace(/"/g, '')));
    }

    for (const col of columns) {
      if (col.is_primary) continue;
      if (existingCols.has(col.column_name)) continue;

      const name = col.column_name.toLowerCase();
      const type = col.data_type.toLowerCase();

      // Heuristic: common patterns that benefit from indexes
      let reason = null;
      if (name.endsWith('_id') || name.endsWith('id')) reason = 'Foreign key / lookup column';
      else if (name === 'email' || name === 'username' || name === 'login' || name === 'name') reason = 'Frequently queried identifier';
      else if (name === 'status' || name === 'state' || name === 'type' || name === 'kind') reason = 'Filter/status column (consider partial index)';
      else if (name === 'created_at' || name === 'updated_at' || name === 'date' || name === 'timestamp') reason = 'Time-range query column';
      else if (name === 'token' || name === 'session_id' || name === 'uuid' || name === 'code' || name === 'slug') reason = 'Unique lookup column';
      else if (type === 'uuid') reason = 'UUID lookup column';

      if (reason) {
        const idxName = `idx_${table}_${col.column_name}`;
        suggestions.push({
          column: col.column_name,
          type: col.data_type,
          reason,
          sql: `CREATE INDEX ${idxName} ON "${schema}"."${table}" ("${col.column_name}");`,
        });
      }
    }

    res.json({
      schema, table,
      stats: stats[0] || null,
      columns,
      indexes,
      topQueries,
      suggestions,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/recommendations', cached('recs', 15_000, async (req) => {
  const dbName = getDbParam(req);
  const recs = [];

    // 1. Tables with high seq scans (DB-specific)
    const missingIdx = await queryDb(dbName, `
      SELECT schemaname, relname, seq_scan, idx_scan, n_live_tup
      FROM pg_stat_user_tables
      WHERE seq_scan > 100 AND n_live_tup > 10000
        AND (idx_scan IS NULL OR idx_scan = 0 OR seq_scan > idx_scan * 10)
      ORDER BY seq_scan DESC LIMIT 5
    `);
    missingIdx.forEach(r => recs.push({
      severity: 'warning', category: 'Indexes',
      message: `Table "${r.schemaname}.${r.relname}" has ${Number(r.seq_scan).toLocaleString()} seq scans vs ${Number(r.idx_scan || 0).toLocaleString()} idx scans (${Number(r.n_live_tup).toLocaleString()} rows)`,
      detail: 'Consider adding indexes for frequently queried columns.',
      action: 'index-advisor', schema: r.schemaname, table: r.relname,
    }));

    // 2. Tables not analyzed (DB-specific)
    const noAnalyze = await queryDb(dbName, `
      SELECT schemaname, relname, n_live_tup, last_analyze, last_autoanalyze
      FROM pg_stat_user_tables
      WHERE n_live_tup > 1000
        AND last_analyze IS NULL AND last_autoanalyze IS NULL
      ORDER BY n_live_tup DESC LIMIT 5
    `);
    noAnalyze.forEach(r => recs.push({
      severity: 'warning', category: 'Maintenance',
      message: `Table "${r.schemaname}.${r.relname}" (${Number(r.n_live_tup).toLocaleString()} rows) has never been analyzed`,
      detail: 'Run ANALYZE to update planner statistics.',
      action: 'index-advisor', schema: r.schemaname, table: r.relname,
    }));

    // 3. High dead rows (DB-specific)
    const deadRows = await queryDb(dbName, `
      SELECT schemaname, relname, n_live_tup, n_dead_tup,
        round(n_dead_tup::numeric / NULLIF(n_live_tup, 0) * 100, 2) AS dead_pct
      FROM pg_stat_user_tables
      WHERE n_dead_tup > 10000 AND n_dead_tup > n_live_tup * 0.2
      ORDER BY n_dead_tup DESC LIMIT 5
    `);
    deadRows.forEach(r => recs.push({
      severity: parseFloat(r.dead_pct) > 50 ? 'critical' : 'warning', category: 'Maintenance',
      message: `Table "${r.schemaname}.${r.relname}" has ${Number(r.n_dead_tup).toLocaleString()} dead rows (${r.dead_pct}% of live)`,
      detail: 'Run VACUUM to reclaim space.',
      action: 'index-advisor', schema: r.schemaname, table: r.relname,
    }));

    // 4. Unused large indexes (DB-specific)
    const unusedIdx = await queryDb(dbName, `
      SELECT s.schemaname, s.relname, s.indexrelname, s.idx_scan,
        pg_size_pretty(pg_relation_size(s.indexrelid)) AS size
      FROM pg_stat_user_indexes s
      JOIN pg_stat_user_tables t ON s.relid = t.relid
      WHERE s.idx_scan = 0 AND t.n_live_tup > 1000 AND pg_relation_size(s.indexrelid) > 65536
      ORDER BY pg_relation_size(s.indexrelid) DESC LIMIT 5
    `);
    unusedIdx.forEach(r => recs.push({
      severity: 'info', category: 'Indexes',
      message: `Index "${r.schemaname}.${r.indexrelname}" on "${r.relname}" (${r.size}) has never been scanned`,
      detail: 'Consider dropping if not needed for constraints.'
    }));

    // 5. XID age (server-wide)
    const xidAge = await query(`
      SELECT datname, age(datfrozenxid) AS xid_age,
        current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max,
        round(age(datfrozenxid)::numeric / current_setting('autovacuum_freeze_max_age')::bigint * 100, 2) AS pct
      FROM pg_database WHERE datistemplate = false AND age(datfrozenxid)::numeric / current_setting('autovacuum_freeze_max_age')::bigint > 0.5
      ORDER BY pct DESC
    `);
    xidAge.forEach(r => recs.push({
      severity: parseFloat(r.pct) > 75 ? 'critical' : 'warning', category: 'Wraparound',
      message: `Database "${r.datname}" is at ${r.pct}% of XID wraparound (age: ${Number(r.xid_age).toLocaleString()})`,
      detail: 'Run aggressive VACUUM FREEZE on large tables.'
    }));

    // 6. Invalid indexes (DB-specific)
    const invalidIdx = await queryDb(dbName, `
      SELECT n.nspname, i.relname FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid
      JOIN pg_namespace n ON n.oid = i.relnamespace
      WHERE NOT x.indisvalid
    `);
    invalidIdx.forEach(r => recs.push({
      severity: 'critical', category: 'Indexes',
      message: `Index "${r.nspname}.${r.relname}" is invalid`,
      detail: 'REINDEX or drop and recreate the index.'
    }));

    // 7. Inactive replication slots (server-wide)
    const inactiveSlots = await query(`
      SELECT slot_name FROM pg_replication_slots WHERE NOT active
    `);
    inactiveSlots.forEach(r => recs.push({
      severity: 'critical', category: 'Replication',
      message: `Replication slot "${r.slot_name}" is inactive`,
      detail: 'Inactive slots prevent WAL cleanup and cause disk bloat. Drop if no longer needed.'
    }));

    // 8. Sequences near exhaustion (DB-specific)
    const seqWarn = await queryDb(dbName, `
      SELECT schemaname, sequencename, last_value, max_value,
        round((last_value::numeric / max_value) * 100, 2) AS pct_used
      FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog','information_schema')
        AND max_value > 0 AND (last_value::numeric / max_value) > 0.75
    `);
    seqWarn.forEach(r => recs.push({
      severity: parseFloat(r.pct_used) > 90 ? 'critical' : 'warning', category: 'Sequences',
      message: `Sequence "${r.schemaname}.${r.sequencename}" is ${r.pct_used}% consumed`,
      detail: 'Consider migrating to bigint or resetting the sequence.'
    }));

  recs.sort((a, b) => {
    const ord = { critical: 0, warning: 1, info: 2 };
    return (ord[a.severity] || 9) - (ord[b.severity] || 9);
  });

  return recs;
}));

// ─── Health Check Summary ─────────────────────────────────────────
app.get('/api/health', async (req, res) => {
  try {
    const checks = [];

    // 1. Connection usage
    const connRows = await query(`
      SELECT current_setting('max_connections')::int AS max_conn,
        (SELECT count(*) FROM pg_stat_activity) AS current_conn
    `);
    const connPct = (connRows[0].current_conn / connRows[0].max_conn) * 100;
    checks.push({
      name: 'Connection Usage',
      value: `${connRows[0].current_conn} / ${connRows[0].max_conn} (${connPct.toFixed(1)}%)`,
      status: connPct > 90 ? 'critical' : connPct > 70 ? 'warning' : 'ok',
      hint: connPct > 70 ? 'High connection usage indicates too many open connections. Check for connection leaks in your application, ensure connections are being returned to the pool, and consider using a connection pooler like PgBouncer. You can also increase max_connections in postgresql.conf, but this requires more shared memory.' : '',
      actions: connPct > 70 ? [{ id: 'terminate-idle', label: 'Terminate Idle Connections' }] : [],
    });

    // 2. Long running queries
    const longQ = await query(`
      SELECT count(*) AS cnt FROM pg_stat_activity
      WHERE state = 'active' AND pid != pg_backend_pid() AND now() - query_start > interval '30 seconds'
    `);
    checks.push({ name: 'Long Queries (>30s)', value: longQ[0].cnt,
      status: parseInt(longQ[0].cnt) > 5 ? 'critical' : parseInt(longQ[0].cnt) > 0 ? 'warning' : 'ok',
      hint: parseInt(longQ[0].cnt) > 0 ? 'Long-running queries can degrade performance and hold locks. Check the Long-Running Queries section below for details. Consider adding missing indexes, optimizing query plans with EXPLAIN ANALYZE, or setting a statement_timeout to prevent runaway queries.' : '',
      actions: parseInt(longQ[0].cnt) > 0 ? [{ id: 'cancel-long-queries', label: 'Cancel Long Queries' }] : [] });

    // 3. Locks waiting
    const lockW = await query('SELECT count(*) AS cnt FROM pg_locks WHERE NOT granted');
    checks.push({ name: 'Waiting Locks', value: lockW[0].cnt,
      status: parseInt(lockW[0].cnt) > 10 ? 'critical' : parseInt(lockW[0].cnt) > 0 ? 'warning' : 'ok',
      hint: parseInt(lockW[0].cnt) > 0 ? 'Queries are waiting to acquire locks, which causes contention and slowdowns. Check the Blocking Chains section for lock holders. Common fixes: keep transactions short, avoid long-running transactions during peak hours, and ensure consistent table access order to prevent deadlocks.' : '',
      actions: [] });

    // 4. Deadlocks
    const deadlocks = await query('SELECT sum(deadlocks) AS cnt FROM pg_stat_database');
    checks.push({ name: 'Total Deadlocks', value: deadlocks[0].cnt || 0,
      status: parseInt(deadlocks[0].cnt || 0) > 0 ? 'warning' : 'ok',
      hint: parseInt(deadlocks[0].cnt || 0) > 0 ? 'Deadlocks occur when two or more transactions hold locks that block each other. Ensure all transactions acquire locks in a consistent order. Review application code for concurrent updates to the same rows. Enable log_lock_waits in postgresql.conf to capture details in the server log.' : '',
      actions: parseInt(deadlocks[0].cnt || 0) > 0 ? [{ id: 'reset-stats', label: 'Reset Statistics' }] : [] });

    // 5. Cache hit ratio
    const cache = await query(`
      SELECT CASE WHEN sum(blks_hit + blks_read) > 0
        THEN round(sum(blks_hit)::numeric / sum(blks_hit + blks_read) * 100, 2) ELSE 100
      END AS ratio FROM pg_stat_database
    `);
    const cacheRatio = parseFloat(cache[0].ratio);
    checks.push({ name: 'Cache Hit Ratio', value: `${cacheRatio}%`,
      status: cacheRatio < 90 ? 'critical' : cacheRatio < 95 ? 'warning' : 'ok',
      hint: cacheRatio < 95 ? 'A low cache hit ratio means PostgreSQL is reading from disk instead of memory. Increase shared_buffers (typically 25% of system RAM) and effective_cache_size (typically 50-75% of system RAM) in postgresql.conf. Also check for sequential scans on large tables — adding appropriate indexes can dramatically improve cache efficiency.' : '',
      actions: cacheRatio < 95 ? [{ id: 'analyze-tables', label: 'Analyze Tables' }] : [] });

    // 6. Rollback ratio
    const rb = await query(`
      SELECT CASE WHEN sum(xact_commit + xact_rollback) > 0
        THEN round(sum(xact_rollback)::numeric / sum(xact_commit + xact_rollback) * 100, 2) ELSE 0
      END AS ratio FROM pg_stat_database
    `);
    const rbRatio = parseFloat(rb[0].ratio);
    checks.push({ name: 'Rollback Ratio', value: `${rbRatio}%`,
      status: rbRatio > 5 ? 'critical' : rbRatio > 1 ? 'warning' : 'ok',
      hint: rbRatio > 1 ? 'A high rollback ratio indicates many transactions are failing. This can be caused by application errors, constraint violations, deadlocks, or serialization failures. Review your application error logs to identify the root cause. Check for constraint violations and ensure proper error handling in your transaction logic.' : '',
      actions: rbRatio > 1 ? [{ id: 'reset-stats', label: 'Reset Statistics' }] : [] });

    // 7. Idle in transaction
    const idleTx = await query(`
      SELECT count(*) AS cnt FROM pg_stat_activity
      WHERE state = 'idle in transaction' AND now() - state_change > interval '5 minutes'
    `);
    checks.push({ name: 'Idle-in-Transaction (>5m)', value: idleTx[0].cnt,
      status: parseInt(idleTx[0].cnt) > 5 ? 'critical' : parseInt(idleTx[0].cnt) > 0 ? 'warning' : 'ok',
      hint: parseInt(idleTx[0].cnt) > 0 ? 'Sessions stuck in "idle in transaction" hold locks and prevent vacuum from cleaning up dead rows. This is usually caused by application code that opens a transaction but fails to commit or rollback. Set idle_in_transaction_session_timeout in postgresql.conf to automatically terminate these sessions.' : '',
      actions: parseInt(idleTx[0].cnt) > 0 ? [{ id: 'terminate-idle-tx', label: 'Terminate Idle Transactions' }] : [] });

    // 8. Tables needing vacuum
    const needVac = await query(`
      SELECT count(*) AS cnt FROM pg_stat_user_tables
      WHERE n_dead_tup > 1000 AND (last_autovacuum IS NULL OR last_autovacuum < now() - interval '1 day')
    `);
    checks.push({ name: 'Tables Need Vacuum', value: needVac[0].cnt,
      status: parseInt(needVac[0].cnt) > 10 ? 'critical' : parseInt(needVac[0].cnt) > 0 ? 'warning' : 'ok',
      hint: parseInt(needVac[0].cnt) > 0 ? 'Tables with many dead rows need vacuuming to reclaim space and maintain query performance. Run VACUUM ANALYZE on affected tables. If autovacuum is falling behind, tune autovacuum_vacuum_scale_factor (lower = more aggressive) and autovacuum_max_workers (more workers = more parallelism) in postgresql.conf.' : '',
      actions: parseInt(needVac[0].cnt) > 0 ? [{ id: 'vacuum-tables', label: 'Run VACUUM ANALYZE' }] : [] });

    // 9. XID Wraparound Risk
    const xidRisk = await query(`
      SELECT max(round(age(datfrozenxid)::numeric / current_setting('autovacuum_freeze_max_age')::bigint * 100, 2)) AS max_pct
      FROM pg_database WHERE datistemplate = false
    `);
    const xidPct = parseFloat(xidRisk[0].max_pct || 0);
    checks.push({ name: 'XID Wraparound Risk', value: `${xidPct}%`,
      status: xidPct > 75 ? 'critical' : xidPct > 50 ? 'warning' : 'ok',
      hint: xidPct > 50 ? 'Transaction ID wraparound can cause the database to shut down to prevent data corruption. Run VACUUM FREEZE on the affected databases immediately. Check for long-running transactions that prevent XID advancement. If autovacuum is not keeping up, increase autovacuum_freeze_max_age and run manual VACUUM FREEZE on the largest tables.' : '',
      actions: xidPct > 50 ? [{ id: 'vacuum-freeze', label: 'Run VACUUM FREEZE' }] : [] });

    // 10. Inactive Replication Slots
    const inactSlots = await query("SELECT count(*) AS cnt FROM pg_replication_slots WHERE NOT active");
    checks.push({ name: 'Inactive Repl. Slots', value: inactSlots[0].cnt,
      status: parseInt(inactSlots[0].cnt) > 0 ? 'warning' : 'ok',
      hint: parseInt(inactSlots[0].cnt) > 0 ? 'Inactive replication slots prevent WAL files from being cleaned up, causing disk usage to grow indefinitely. If the subscriber is permanently gone, drop the slot with pg_drop_replication_slot(). If it is temporarily down, restore the replica as soon as possible. Monitor pg_replication_slots regularly.' : '',
      actions: parseInt(inactSlots[0].cnt) > 0 ? [{ id: 'drop-inactive-slots', label: 'Drop Inactive Slots' }] : [] });

    // 11. WAL Archiver Failures
    const archFail = await query('SELECT failed_count FROM pg_stat_archiver');
    checks.push({ name: 'WAL Archive Failures', value: archFail[0].failed_count || 0,
      status: parseInt(archFail[0].failed_count || 0) > 0 ? 'warning' : 'ok',
      hint: parseInt(archFail[0].failed_count || 0) > 0 ? 'WAL archiving failures mean point-in-time recovery backups may be incomplete. Check your archive_command in postgresql.conf for errors. Verify the archive destination has sufficient disk space and correct permissions. Review the PostgreSQL server logs for specific archiver error messages.' : '',
      actions: [] });

    // 12. Sequence Exhaustion
    const seqExhaust = await query(`
      SELECT count(*) AS cnt FROM pg_sequences
      WHERE schemaname NOT IN ('pg_catalog','information_schema')
        AND max_value > 0 AND (last_value::numeric / max_value) > 0.75
    `);
    checks.push({ name: 'Sequences Near Limit', value: seqExhaust[0].cnt,
      status: parseInt(seqExhaust[0].cnt) > 0 ? 'warning' : 'ok',
      hint: parseInt(seqExhaust[0].cnt) > 0 ? 'Sequences approaching their maximum value will cause INSERT failures when exhausted. Alter the sequence to use a larger data type (e.g., ALTER SEQUENCE seq AS bigint) or increase the max_value. For identity columns, alter the column type to bigint. Plan this migration during a maintenance window.' : '',
      actions: [] });

    const overallStatus = checks.some(c => c.status === 'critical') ? 'critical'
      : checks.some(c => c.status === 'warning') ? 'warning' : 'ok';
    res.json({ status: overallStatus, checks });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Topology (?db= for table drill-down) ──────────────────────────
app.get('/api/topology', async (req, res) => {
  try {
    const dbName = getDbParam(req);

    // Per-database stats with health scoring (server-wide)
    const databases = await query(`
      SELECT
        d.datname AS name,
        pg_size_pretty(pg_database_size(d.datname)) AS size,
        pg_database_size(d.datname) AS size_bytes,
        s.numbackends AS connections,
        s.xact_commit AS commits,
        s.xact_rollback AS rollbacks,
        CASE WHEN (s.xact_commit + s.xact_rollback) > 0
          THEN round(s.xact_rollback::numeric / (s.xact_commit + s.xact_rollback) * 100, 2)
          ELSE 0
        END AS rollback_pct,
        CASE WHEN (s.blks_hit + s.blks_read) > 0
          THEN round(s.blks_hit::numeric / (s.blks_hit + s.blks_read) * 100, 2)
          ELSE 100
        END AS cache_hit_ratio,
        s.deadlocks,
        s.conflicts,
        s.temp_files,
        age(d.datfrozenxid) AS xid_age,
        current_setting('autovacuum_freeze_max_age')::bigint AS freeze_max_age,
        round(age(d.datfrozenxid)::numeric / current_setting('autovacuum_freeze_max_age')::bigint * 100, 2) AS xid_pct,
        current_setting('max_connections')::int AS max_connections
      FROM pg_database d
      JOIN pg_stat_database s ON d.datname = s.datname
      WHERE d.datistemplate = false
      ORDER BY pg_database_size(d.datname) DESC
    `);

    // Compute per-database health
    const dbHealth = databases.map(db => {
      const issues = [];
      let status = 'ok';

      const cacheHit = parseFloat(db.cache_hit_ratio);
      if (cacheHit < 90) { issues.push(`Cache hit ${cacheHit}% (critical <90%)`); status = 'critical'; }
      else if (cacheHit < 95) { issues.push(`Cache hit ${cacheHit}% (warn <95%)`); if (status !== 'critical') status = 'warning'; }

      const rbPct = parseFloat(db.rollback_pct);
      if (rbPct > 5) { issues.push(`Rollback rate ${rbPct}%`); status = 'critical'; }
      else if (rbPct > 1) { issues.push(`Rollback rate ${rbPct}%`); if (status !== 'critical') status = 'warning'; }

      if (parseInt(db.deadlocks) > 0) { issues.push(`${db.deadlocks} deadlocks`); if (status !== 'critical') status = 'warning'; }

      const xidPct = parseFloat(db.xid_pct);
      if (xidPct > 75) { issues.push(`XID wraparound ${xidPct}%`); status = 'critical'; }
      else if (xidPct > 50) { issues.push(`XID wraparound ${xidPct}%`); if (status !== 'critical') status = 'warning'; }

      if (parseInt(db.conflicts) > 0) { issues.push(`${db.conflicts} conflicts`); if (status !== 'critical') status = 'warning'; }

      return { ...db, status, issues };
    });

    // Tables for the requested database (or default)
    const targetDb = dbName || defaultDbName;
    const tables = await queryDb(dbName, `
      SELECT
        s.schemaname AS schema, s.relname AS table,
        pg_size_pretty(pg_total_relation_size(s.relid)) AS total_size,
        n_live_tup AS live_rows, n_dead_tup AS dead_rows,
        CASE WHEN n_live_tup > 0 THEN round(n_dead_tup::numeric / n_live_tup * 100, 2) ELSE 0 END AS dead_row_pct,
        seq_scan, idx_scan,
        last_autovacuum
      FROM pg_stat_user_tables s
      ORDER BY pg_total_relation_size(s.relid) DESC LIMIT 30
    `);

    // Compute per-table health
    const tableHealth = tables.map(t => {
      let status = 'ok';
      const issues = [];
      const deadPct = parseFloat(t.dead_row_pct);
      if (deadPct > 50) { status = 'critical'; issues.push(`${deadPct}% dead rows`); }
      else if (deadPct > 20) { if (status !== 'critical') status = 'warning'; issues.push(`${deadPct}% dead rows`); }

      const seqScan = parseInt(t.seq_scan || 0);
      const idxScan = parseInt(t.idx_scan || 0);
      if (seqScan > 100 && parseInt(t.live_rows) > 10000 && (idxScan === 0 || seqScan > idxScan * 10)) {
        if (status !== 'critical') status = 'warning';
        issues.push('High seq scans, missing indexes?');
      }

      return { ...t, status, issues };
    });

    // Server info
    const serverInfo = (await query(`
      SELECT
        current_setting('server_version') AS version,
        inet_server_addr() AS host,
        inet_server_port() AS port,
        now() - pg_postmaster_start_time() AS uptime,
        current_setting('max_connections')::int AS max_connections,
        (SELECT count(*) FROM pg_stat_activity) AS total_connections
    `))[0];

    res.json({ server: serverInfo, databases: dbHealth, tables: tableHealth, tables_db: targetDb });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Topology Activity (lightweight, called frequently) ───────────
app.get('/api/topology-activity', (req, res) => {
  res.json({ databases: queryTracker.getActivitySummary() });
});

// ─── Per-database queries (running + recent 60s) ─────────────────
app.get('/api/db-queries/:dbName', (req, res) => {
  const data = queryTracker.getByDatabase(req.params.dbName);
  res.json(data);
});

// ─── Cancel / Terminate a backend ──────────────────────────────────
function validatePid(pid) {
  const n = parseInt(pid, 10);
  return Number.isInteger(n) && n > 0 ? n : null;
}

app.post('/api/cancel/:pid', async (req, res) => {
  try {
    const pid = validatePid(req.params.pid);
    if (!pid) return res.status(400).json({ error: 'Invalid PID' });
    const rows = await query('SELECT pg_cancel_backend($1) AS result', [pid]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/terminate/:pid', async (req, res) => {
  try {
    const pid = validatePid(req.params.pid);
    if (!pid) return res.status(400).json({ error: 'Invalid PID' });
    const rows = await query('SELECT pg_terminate_backend($1) AS result', [pid]);
    res.json(rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Health Check Actions ─────────────────────────────────────────
function quoteIdent(name) {
  return '"' + name.replace(/"/g, '""') + '"';
}

const ALLOWED_ACTIONS = new Set(['terminate-idle', 'cancel-long-queries', 'terminate-idle-tx', 'analyze-tables', 'vacuum-tables', 'vacuum-freeze', 'drop-inactive-slots', 'reset-stats']);

// Preview: returns the SQL and targets that will be affected
app.get('/api/health-action/:action/preview', async (req, res) => {
  try {
    const action = req.params.action;
    if (!ALLOWED_ACTIONS.has(action)) return res.status(400).json({ error: 'Unknown action' });
    let preview;

    switch (action) {
      case 'terminate-idle': {
        const rows = await query(`
          SELECT pid, usename, datname, client_addr,
            now() - query_start AS idle_duration
          FROM pg_stat_activity
          WHERE state = 'idle' AND pid != pg_backend_pid()
            AND query_start < now() - interval '5 minutes'
          ORDER BY query_start
        `);
        preview = {
          title: 'Terminate Idle Connections',
          description: 'Terminates backend connections that have been idle for more than 5 minutes. This frees up connection slots but will disconnect those clients.',
          targets: rows.map(r => ({ name: `PID ${r.pid}`, detail: `${r.usename}@${r.datname} — idle ${r.idle_duration}` })),
          queries: rows.map(r => `SELECT pg_terminate_backend(${parseInt(r.pid, 10)});`),
        };
        break;
      }
      case 'cancel-long-queries': {
        const rows = await query(`
          SELECT pid, usename, datname, left(query, 100) AS query_preview,
            now() - query_start AS duration
          FROM pg_stat_activity
          WHERE state = 'active' AND pid != pg_backend_pid()
            AND now() - query_start > interval '30 seconds'
          ORDER BY query_start
        `);
        preview = {
          title: 'Cancel Long-Running Queries',
          description: 'Sends a cancel signal to all queries running longer than 30 seconds. The queries will be cancelled but connections remain open.',
          targets: rows.map(r => ({ name: `PID ${r.pid}`, detail: `${r.usename}@${r.datname} — ${r.duration} — ${r.query_preview}` })),
          queries: rows.map(r => `SELECT pg_cancel_backend(${parseInt(r.pid, 10)});`),
        };
        break;
      }
      case 'terminate-idle-tx': {
        const rows = await query(`
          SELECT pid, usename, datname, client_addr,
            now() - state_change AS idle_duration
          FROM pg_stat_activity
          WHERE state = 'idle in transaction' AND pid != pg_backend_pid()
            AND now() - state_change > interval '5 minutes'
          ORDER BY state_change
        `);
        preview = {
          title: 'Terminate Idle-in-Transaction Sessions',
          description: 'Terminates sessions stuck in "idle in transaction" for more than 5 minutes. These sessions hold locks and prevent vacuum from reclaiming dead rows.',
          targets: rows.map(r => ({ name: `PID ${r.pid}`, detail: `${r.usename}@${r.datname} — idle in tx ${r.idle_duration}` })),
          queries: rows.map(r => `SELECT pg_terminate_backend(${parseInt(r.pid, 10)});`),
        };
        break;
      }
      case 'analyze-tables': {
        const tables = await query(`
          SELECT schemaname, relname, seq_scan, idx_scan, n_live_tup,
            CASE WHEN last_analyze IS NOT NULL THEN now() - last_analyze END AS since_analyze,
            CASE WHEN last_autoanalyze IS NOT NULL THEN now() - last_autoanalyze END AS since_autoanalyze
          FROM pg_stat_user_tables
          WHERE n_live_tup > 0
          ORDER BY n_live_tup DESC LIMIT 30
        `);
        preview = {
          title: 'Analyze Tables',
          description: 'Runs ANALYZE on all user tables to refresh planner statistics. This helps PostgreSQL choose better query plans, reduce sequential scans, and improve overall cache hit ratio.',
          targets: tables.map(t => {
            const parts = [`${Number(t.n_live_tup).toLocaleString()} rows`, `${Number(t.seq_scan || 0).toLocaleString()} seq / ${Number(t.idx_scan || 0).toLocaleString()} idx scans`];
            return { name: `${t.schemaname}.${t.relname}`, detail: parts.join(' — ') };
          }),
          queries: tables.map(t => `ANALYZE ${quoteIdent(t.schemaname)}.${quoteIdent(t.relname)};`),
        };
        break;
      }
      case 'vacuum-tables': {
        const tables = await query(`
          SELECT schemaname, relname, n_dead_tup, last_autovacuum
          FROM pg_stat_user_tables
          WHERE n_dead_tup > 1000
            AND (last_autovacuum IS NULL OR last_autovacuum < now() - interval '1 day')
          ORDER BY n_dead_tup DESC LIMIT 20
        `);
        preview = {
          title: 'Run VACUUM ANALYZE',
          description: 'Runs VACUUM ANALYZE on tables with high dead row counts to reclaim disk space, update planner statistics, and improve query performance.',
          targets: tables.map(t => ({ name: `${t.schemaname}.${t.relname}`, detail: `${Number(t.n_dead_tup).toLocaleString()} dead rows` })),
          queries: tables.map(t => `VACUUM ANALYZE ${quoteIdent(t.schemaname)}.${quoteIdent(t.relname)};`),
        };
        break;
      }
      case 'vacuum-freeze': {
        const tables = await query(`
          SELECT schemaname, relname, age(relfrozenxid) AS xid_age
          FROM pg_stat_user_tables
          ORDER BY age(relfrozenxid) DESC LIMIT 10
        `);
        preview = {
          title: 'Run VACUUM FREEZE',
          description: 'Runs VACUUM FREEZE on the tables with the oldest transaction IDs to prevent XID wraparound, which can force the database to shut down.',
          targets: tables.map(t => ({ name: `${t.schemaname}.${t.relname}`, detail: `XID age: ${Number(t.xid_age).toLocaleString()}` })),
          queries: tables.map(t => `VACUUM FREEZE ${quoteIdent(t.schemaname)}.${quoteIdent(t.relname)};`),
        };
        break;
      }
      case 'drop-inactive-slots': {
        const slots = await query("SELECT slot_name, slot_type, database FROM pg_replication_slots WHERE NOT active");
        preview = {
          title: 'Drop Inactive Replication Slots',
          description: 'Drops all inactive replication slots. Inactive slots prevent WAL cleanup and cause disk usage to grow. Only drop slots if you are sure the subscriber is permanently gone.',
          targets: slots.map(s => ({ name: s.slot_name, detail: `${s.slot_type} — database: ${s.database || 'physical'}` })),
          queries: slots.map(s => `SELECT pg_drop_replication_slot('${s.slot_name.replace(/'/g, "''")}');`),
        };
        break;
      }
      case 'reset-stats': {
        preview = {
          title: 'Reset Statistics Counters',
          description: 'Resets all statistics counters for the current database (deadlocks, rollbacks, etc.) to zero. This does not affect database operation — only the statistics views.',
          targets: [{ name: 'pg_stat_database', detail: 'All counters will be reset to zero' }],
          queries: ['SELECT pg_stat_reset();'],
        };
        break;
      }
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    if (preview.targets.length === 0) {
      preview.empty = true;
      preview.description = 'No items found that need this action right now. The issue may have resolved itself.';
      preview.queries = [];
    }

    res.json(preview);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Execute: streams progress via SSE
app.post('/api/health-action/:action', async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  function send(data) {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  }

  try {
    const action = req.params.action;
    if (!ALLOWED_ACTIONS.has(action)) { send({ step: -1, status: 'error', message: 'Unknown action' }); return res.end(); }
    let steps = [];

    switch (action) {
      case 'terminate-idle': {
        const rows = await query(`
          SELECT pid, usename, datname FROM pg_stat_activity
          WHERE state = 'idle' AND pid != pg_backend_pid()
            AND query_start < now() - interval '5 minutes'
        `);
        steps = rows.map(r => ({ rawSql: 'SELECT pg_terminate_backend($1)', params: [parseInt(r.pid, 10)], label: `Terminate PID ${r.pid} (${r.usename}@${r.datname})` }));
        break;
      }
      case 'cancel-long-queries': {
        const rows = await query(`
          SELECT pid, usename, datname FROM pg_stat_activity
          WHERE state = 'active' AND pid != pg_backend_pid()
            AND now() - query_start > interval '30 seconds'
        `);
        steps = rows.map(r => ({ rawSql: 'SELECT pg_cancel_backend($1)', params: [parseInt(r.pid, 10)], label: `Cancel PID ${r.pid} (${r.usename}@${r.datname})` }));
        break;
      }
      case 'terminate-idle-tx': {
        const rows = await query(`
          SELECT pid, usename, datname FROM pg_stat_activity
          WHERE state = 'idle in transaction' AND pid != pg_backend_pid()
            AND now() - state_change > interval '5 minutes'
        `);
        steps = rows.map(r => ({ rawSql: 'SELECT pg_terminate_backend($1)', params: [parseInt(r.pid, 10)], label: `Terminate PID ${r.pid} (${r.usename}@${r.datname})` }));
        break;
      }
      case 'analyze-tables': {
        const tables = await query(`
          SELECT schemaname, relname FROM pg_stat_user_tables
          WHERE n_live_tup > 0
          ORDER BY n_live_tup DESC LIMIT 30
        `);
        steps = tables.map(t => ({
          sql: `ANALYZE ${quoteIdent(t.schemaname)}.${quoteIdent(t.relname)}`,
          label: `ANALYZE ${t.schemaname}.${t.relname}`,
        }));
        break;
      }
      case 'vacuum-tables': {
        const tables = await query(`
          SELECT schemaname, relname FROM pg_stat_user_tables
          WHERE n_dead_tup > 1000
            AND (last_autovacuum IS NULL OR last_autovacuum < now() - interval '1 day')
          ORDER BY n_dead_tup DESC LIMIT 20
        `);
        steps = tables.map(t => ({
          sql: `VACUUM ANALYZE ${quoteIdent(t.schemaname)}.${quoteIdent(t.relname)}`,
          label: `VACUUM ANALYZE ${t.schemaname}.${t.relname}`,
        }));
        break;
      }
      case 'vacuum-freeze': {
        const tables = await query(`
          SELECT schemaname, relname FROM pg_stat_user_tables
          ORDER BY age(relfrozenxid) DESC LIMIT 10
        `);
        steps = tables.map(t => ({
          sql: `VACUUM FREEZE ${quoteIdent(t.schemaname)}.${quoteIdent(t.relname)}`,
          label: `VACUUM FREEZE ${t.schemaname}.${t.relname}`,
        }));
        break;
      }
      case 'drop-inactive-slots': {
        const slots = await query("SELECT slot_name FROM pg_replication_slots WHERE NOT active");
        steps = slots.map(s => ({
          sql: null, params: [s.slot_name],
          rawSql: "SELECT pg_drop_replication_slot($1)",
          label: `Drop slot: ${s.slot_name}`,
        }));
        break;
      }
      case 'reset-stats': {
        steps = [{ sql: 'SELECT pg_stat_reset()', label: 'Reset statistics counters' }];
        break;
      }
      default:
        send({ step: -1, status: 'error', message: `Unknown action: ${action}` });
        return res.end();
    }

    const total = steps.length;
    let completed = 0;
    let failed = 0;

    for (let i = 0; i < steps.length; i++) {
      const s = steps[i];
      send({ step: i + 1, total, label: s.label, status: 'running' });
      const start = Date.now();
      try {
        if (s.rawSql) {
          await query(s.rawSql, s.params);
        } else {
          await query(s.sql);
        }
        const duration = Date.now() - start;
        completed++;
        send({ step: i + 1, total, label: s.label, status: 'done', duration });
      } catch (err) {
        const duration = Date.now() - start;
        failed++;
        send({ step: i + 1, total, label: s.label, status: 'error', duration, error: err.message });
      }
    }

    send({ step: -1, status: 'complete', completed, failed, total });
    res.end();
  } catch (err) {
    send({ step: -1, status: 'error', message: err.message });
    res.end();
  }
});

app.listen(port, () => {
  console.log(`PostgreSQL Monitor running at http://localhost:${port}`);
});
