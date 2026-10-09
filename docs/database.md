# NowOps Standalone — Database

**Status:** draft for review · **Date:** 2026-10-08 · **Owner:** NowOps team
**Companion documents:** `docs/architecture.md` (§14 tenancy, §15 summary, §19 open questions), `docs/decisions.md` (D-001, D-003, D-004, D-008, D-011, D-013, D-014, D-016, D-017, D-018).

What this document covers: what NowOps stores, how it is shaped, how it stays fast as it grows, and how long it is kept. It uses the architecture's conventions: design choices made here are proposals for review unless they cite a decision or the code. Unknown values are **`<TBD>`** with the architecture question that settles them (Q-numbers refer to architecture §19). Where this document and the decision log disagree, the log wins and this document is corrected.

**Today there is no database.** State lives in in-process `Map`s (`src/server.ts`, `mockup/server.ts`), browser `localStorage` and `.env`. Everything below is the target: PostgreSQL 16 on RDS, accessed through drizzle-orm and `pg`, with migrations from drizzle-kit (architecture §8).

**Principle.** ServiceNow is the system of record for everything about the client's work (D-001, D-003). Postgres holds only what NowOps itself owns: tenants, invites, connections, users, definitions, the derived profile, chats, and short-lived caches (D-017). Build only what release 1 needs.

---

## 1. What we store, and what we never store

| Data | Stored? | Where | Why |
|---|---|---|---|
| Tenants, invites, connections, users | Yes | `tenants`, `invites`, `connections`, `users` | NowOps' own records; onboarding by invite (D-016) |
| A tenant's LLM choice | Yes | `tenants` | UST gateway or the client's own endpoint (architecture §7 flow 7, P-10) |
| KPI definitions | Yes, versioned | `definitions` | NowOps owns every definition (D-004) |
| Tenant profile (state classes, SLA match, time zone, tables present, overrides) | Yes | `tenant_profile`, `tenant_profile_history` | Read from the instance (D-008, D-011) |
| Chat questions and answers, with the tool trace | Yes, retention `<TBD>` (Q16) | `chats`, `chat_messages` | History and context for follow-up questions. Can quote ticket text (D-017) |
| Resolve drafts | Yes, time backstop `<TBD>` (P-8) | `llm_output_cache` | Avoid paying for the same draft twice (P-8). Can quote ticket text (D-017) |
| Model token use per tenant per day | Yes, for tenants on the UST gateway | `llm_usage` | Per-tenant daily budget (P-10), shared across tasks |
| Sessions, including the user's ServiceNow tokens | Yes, encrypted, until expiry | `sessions` | Server-side sessions (architecture §13) |
| Ticket rows, record lists, journal text, article bodies, CMDB records | **No**. Read live, cached in memory for minutes | — | ServiceNow is the system of record (D-001, D-003) |
| Writes to client records | **No** NowOps copy | — | They run as the user; ServiceNow's history records them (D-014) |
| Figures (tile values, series, breakdowns) | **No**, not even as history | — | Every number is read from the instance (D-013) |
| Passwords, SSO assertions | **No** | — | The client's SSO, through their ServiceNow sign-in, handles login |
| OAuth client secrets, client LLM keys, gateway key, session-encryption key | **No** | Secrets Manager; the database holds only the reference | Architecture §13 |
| Personal data and answer text in logs | **No** | — | Logs carry ids, sizes and timings only (architecture §16) |
| National ids, passport, licence and card numbers, patient records | **No, in any table** | — | Organisation policy. Denied fields keep structured identifiers out; masking of free text on the path to the LLM is `<TBD>` (Q15) |

**What chats and drafts may hold (D-017).** An assistant answer or a Resolve draft can quote ticket text: a short description, a caller's name, a line of a journal. It is:
- limited to what the user was shown, never whole records or lists;
- never used as a source for a figure (D-013);
- deleted at the end of its retention, or with its user or tenant (§11).

The tool trace in `chat_messages.trace` holds queries and record `sys_id`s, never result rows.

---

## 2. Conventions

- **Primary keys:** `id uuid DEFAULT gen_random_uuid()` for anything that can appear in a URL or an API response. Internal append-only tables may use `bigint GENERATED ALWAYS AS IDENTITY`.
- **`tenant_id` on every tenant-scoped table**, with `ON DELETE CASCADE` to `tenants`. `tenants` and `definitions` are not tenant-scoped (`definitions` is global: tiles are built once, D-005).
- **Composite foreign keys** keep a child row in its parent's tenant. Each parent has `UNIQUE (tenant_id, id)`, and the child references `(tenant_id, parent_id)`. A chat can then never point at another tenant's user.
- **Timestamps:** `timestamptz`, UTC. `created_at NOT NULL DEFAULT now()` everywhere. `updated_at` only on rows that are updated, set by drizzle's `$onUpdate`. Immutable rows (messages, definition versions, history, cache) have none.
- **No soft delete.** Definitions are versioned (a new row, never an update). Everything else is hard deleted when its retention ends (§11).
- **`jsonb` only for shapes that vary** and are always read whole: the profile, a definition's query spec, a tool trace. Anything a query filters or sorts on is a real column.
- **Constraints live in the database:** NOT NULL, UNIQUE, FK, and CHECK for every enum-like text column (`role`, `status`, `kind`). No Postgres enum types; a CHECK is easier to widen in an expand migration.
- **ServiceNow ids** are `char(32)` with `CHECK (x ~ '^[0-9a-f]{32}$')`.
- **Names:** `snake_case`, plural table names, `<thing>_id` for foreign keys, `<event>_at` for times.
- **Exempt:** the `sessions` table. Its fixed schema belongs to `connect-pg-simple` (§3).

---

## 3. Schema

Owner = the feature folder in `apps/server/src/features/` (architecture §5) whose `repo.ts` is the only writer.

### `tenants`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| subdomain | text | no | | UNIQUE; `CHECK (subdomain ~ '^[a-z0-9][a-z0-9-]{1,39}$')`; the `<client>` in `<client>.nowops.<domain>` (D-018) |
| name | text | no | | Display name |
| status | text | no | `'pending'` | `CHECK IN ('pending','active','suspended')`. `pending` from creation until the client's admin activates it (D-016); `suspended` = sign-in refused |
| llm_provider | text | no | `'ust_gateway'` | `CHECK IN ('ust_gateway','client')` (P-10) |
| llm_endpoint_url | text | yes | | Client endpoint; its host is on the egress allowlist (architecture §7 flow 7) |
| llm_key_arn | text | yes | | Secrets Manager reference for the client's key |
| llm_model | text | yes | | Model id on the client endpoint. On the UST gateway the id is configuration (architecture §12) |
| created_at, updated_at | timestamptz | no | `now()` | |

- `CHECK (llm_provider = 'ust_gateway' OR (llm_endpoint_url IS NOT NULL AND llm_key_arn IS NOT NULL AND llm_model IS NOT NULL))`. The client-endpoint columns follow the interface agreed in Q4 and may change with it.
- **Owner:** tenancy · **Retention:** until offboarding · **Rows:** `<TBD>` (P-4)

### `invites`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| tenant_id | uuid | no | | FK `tenants` cascade |
| token_hash | bytea | no | | SHA-256 of the invite token; UNIQUE. The token itself is never stored |
| expires_at | timestamptz | no | | `created_at + 7 days` (D-016) |
| used_at | timestamptz | yes | | Set when the tenant is activated |
| used_by | uuid | yes | | FK `users` `ON DELETE SET NULL`; the admin who activated |
| created_by | text | no | | The UST person who issued it; form depends on Q9 |
| created_at | timestamptz | no | `now()` | |

- **Single use** is enforced by one statement: `UPDATE invites SET used_at = now(), used_by = $2 WHERE token_hash = $1 AND used_at IS NULL AND expires_at > now() RETURNING tenant_id`. No row returned means expired, used or unknown.
- **Owner:** onboarding · **Retention:** `<TBD>` (Q16) · **Rows:** one or a few per tenant

### `connections`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| tenant_id | uuid | no | | FK `tenants` cascade; UNIQUE (one connection per tenant) |
| instance_url | text | no | | Recorded by UST at tenant creation (D-016). `CHECK (instance_url ~ '^https://[^/]+$')`; custom instance domains allowed |
| oauth_client_id | text | yes | | Entered by the client's admin from their Application Registry entry |
| client_secret_arn | text | yes | | Secrets Manager reference; the secret itself is never in the database |
| activated_at | timestamptz | yes | | Set at activation |
| last_success_at | timestamptz | yes | | Last successful token exchange; shown in Connection health |
| created_at, updated_at | timestamptz | no | `now()` | |

- `CHECK (activated_at IS NULL OR (oauth_client_id IS NOT NULL AND client_secret_arn IS NOT NULL))`.
- The client's entry at the invite must equal `instance_url` exactly (D-016).
- Admins are the holders of the ServiceNow `admin` or `nowops_admin` role (D-014); nothing about roles is stored per connection.
- **Owner:** tenancy · **Retention:** until offboarding; the secret is deleted with it · **Rows:** = tenants

### `users`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK; UNIQUE `(tenant_id, id)` for composite FKs |
| tenant_id | uuid | no | | FK `tenants` cascade |
| sn_sys_id | char(32) | no | | The user's `sys_user.sys_id`; UNIQUE `(tenant_id, sn_sys_id)` |
| email | text | yes | | From `sys_user`, which may have none |
| name | text | no | | From `sys_user` |
| role | text | no | | `CHECK IN ('admin','member')`; `admin` if the user holds `admin` or `nowops_admin` on the instance; re-derived at every sign-in |
| last_sign_in_at | timestamptz | no | | Drives retention |
| created_at, updated_at | timestamptz | no | `now()` | |

- Client staff and UST staff with an account on the instance are rows alike (D-014).
- How the UST person who creates tenants signs in is open (Q9). They are not a row here unless Q9 decides otherwise.
- Groups (`sys_user_grmember`) are not stored; they are cached in memory (§5).
- **Owner:** auth · **Retention:** `<TBD>` after `last_sign_in_at` (Q16) · **Rows:** `<TBD>` (P-4)

### `definitions`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| key | text | no | | e.g. `open_incidents`; PK part 1 |
| version | int | no | | `CHECK (version > 0)`; PK part 2 |
| platform | text | no | `'servicenow'` | D-001, D-004 |
| kind | text | no | `'query'` | `CHECK IN ('query','ratio')` (`src/definitions.ts`) |
| name | text | no | | Tile name |
| meaning | text | no | | Plain-language definition shown with the figure |
| dashboard | text | no | | e.g. `QBR`, `App360` |
| tile_group | text | no | | e.g. `core`, `metrics` |
| tier | text | yes | | `CHECK IN ('B')` |
| spec | jsonb | no | | Query: `table, filter, aggregate, field, when, basis`. Ratio: `num, den`. Placeholders such as `{{open_states}}` stay unresolved here |
| created_at | timestamptz | no | `now()` | |
| created_by | text | no | | The migration or person that added the version |

- **Current definitions** = the view `definitions_current` (`SELECT DISTINCT ON (key) … ORDER BY key, version DESC`).
- **Insert-only by grant:** the app role has `SELECT, INSERT` on this table and no `UPDATE` or `DELETE` (§8). Versioning is enforced by the database, not by convention.
- Per-tenant overrides (P-3) are not definitions; they live in `tenant_profile.overrides`.
- **Owner:** definitions · **Retention:** kept, all versions

### `tenant_profile`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| tenant_id | uuid | no | | PK; FK `tenants` cascade |
| profile | jsonb | no | | Resolved placeholders with evidence, state classes, time zone, automation accounts, tables present, tile visibility (D-008, D-011). Always read whole |
| overrides | jsonb | no | `'{}'` | Admin overrides; win over the scan (D-008) |
| overrides_updated_by | uuid | yes | | FK `users` `ON DELETE SET NULL`. With `updated_at`, the "who and when" for overrides |
| scanned_at | timestamptz | no | | Age shown in Settings |
| scanned_by | uuid | yes | | FK `users` `ON DELETE SET NULL`; whose token ran the scan. An admin, if the proposal in architecture §7 flow 2 is agreed (open in D-016) |
| updated_at | timestamptz | no | `now()` | |

- **Owner:** definitions · **Retention:** until offboarding · **Rows:** = tenants

### `tenant_profile_history`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | bigint identity | no | | PK; internal only |
| tenant_id | uuid | no | | FK `tenants` cascade |
| change | jsonb | no | | One change notice: what changed, old value → new value, and whether it came from the scan or an override |
| changed_by | uuid | yes | | FK `users` `ON DELETE SET NULL` |
| created_at | timestamptz | no | `now()` | |

- **Owner:** definitions · **Retention:** `<TBD>` (Q16)

### `chats`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK; UNIQUE `(tenant_id, id)` |
| tenant_id | uuid | no | | |
| user_id | uuid | no | | FK `(tenant_id, user_id)` → `users (tenant_id, id)` cascade |
| title | text | no | | The first question, cut to 120 characters; `CHECK (length(title) <= 120)` |
| created_at | timestamptz | no | `now()` | |
| updated_at | timestamptz | no | `now()` | Time of the last message; sorts the chat list |

- **Owner:** chat · **Retention:** removed once it has no messages left (§11)

### `chat_messages`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| id | uuid | no | `gen_random_uuid()` | PK |
| tenant_id | uuid | no | | |
| chat_id | uuid | no | | FK `(tenant_id, chat_id)` → `chats (tenant_id, id)` cascade |
| role | text | no | | `CHECK IN ('user','assistant')` |
| text | text | no | | `CHECK (length(text) <= 20000)` |
| trace | jsonb | yes | | Assistant only: tool calls with table, query, aggregate, cited `sys_id`s and verify links, never result rows. `CHECK (role = 'assistant' OR trace IS NULL)` |
| created_at | timestamptz | no | `now()` | |

- The last 12 messages of a chat are the context for the next question (`src/server.ts`).
- **Owner:** chat · **Retention:** `<TBD>` from `created_at` (Q16) · **Rows:** the table to watch (§12)

### `llm_output_cache`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| tenant_id | uuid | no | | FK `tenants` cascade |
| ticket_sys_id | char(32) | no | | |
| kind | text | no | | `CHECK IN ('steps','brief','draft')` (the three Resolve routes) |
| ticket_updated_on | timestamptz | no | | The ticket's `sys_updated_on`; a newer ticket version misses the cache |
| output | text | no | | Model output |
| created_at | timestamptz | no | `now()` | Expiry = `created_at` + the time backstop (P-8) |

- PK `(tenant_id, ticket_sys_id, kind, ticket_updated_on)`
- A hit is served only after the ticket has been read as the current user, which is the ACL check (architecture §7 flow 5).
- **Owner:** resolve · **Retention:** the time backstop, `<TBD>` (P-8)

### `llm_usage`
| Column | Type | Null | Default | Notes |
|---|---|---|---|---|
| tenant_id | uuid | no | | FK `tenants` cascade |
| day | date | no | | UTC |
| input_tokens | bigint | no | 0 | |
| output_tokens | bigint | no | 0 | |
| calls | int | no | 0 | |

- PK `(tenant_id, day)`. Written as one `INSERT … ON CONFLICT DO UPDATE SET input_tokens = llm_usage.input_tokens + EXCLUDED.input_tokens, …` per model call. It is atomic across tasks, so the daily budget holds when several tasks serve one tenant.
- Written only for tenants on the UST gateway; a client's own LLM has no NowOps cap (P-10).
- **Owner:** chat (shared with resolve) · **Retention:** `<TBD>` (Q16)

### `sessions`
The fixed schema of `connect-pg-simple`, with `tableName: 'sessions'`: `sid varchar PRIMARY KEY`, `sess json NOT NULL`, `expire timestamp(6) NOT NULL`, and an index on `expire`. It is created by our migration, not by the library's `createTableIfMissing`, so the app role needs no DDL.

`sess` holds `{ userId, tenantId, role, sn }`, plus `state` (and the PKCE verifier, if ServiceNow supports PKCE: architecture §20 F1) while a sign-in is in progress. `sn` holds the user's ServiceNow access token, refresh token and expiry, **encrypted with AES-256-GCM** (Node `crypto`) under a key from Secrets Manager. Rotating that key signs everyone out.

- **Owner:** auth · **Retention:** idle and absolute timeouts `<TBD>` (Q8)

---

## 4. Query and index plan

Every query on a hot path carries `tenant_id` (§10). Each query either has an index or a stated reason it needs none.

| Query (purpose) | Filter / sort | Index | Rows scanned |
|---|---|---|---|
| Tenant from host (every request; cached, §5) | `subdomain` | UNIQUE `(subdomain)` | 1 |
| Session lookup (every request) | `sid` | PK | 1 |
| Open or spend an invite | `token_hash` | UNIQUE `(token_hash)` | 1 |
| Upsert user at sign-in | `tenant_id, sn_sys_id` | UNIQUE `(tenant_id, sn_sys_id)` | 1 |
| Current definitions (cached) | `DISTINCT ON (key)` | PK `(key, version)` | Whole table (small) |
| Profile for tenant (cached) | `tenant_id` | PK | 1 |
| Chat list for user, newest first, keyset | `tenant_id, user_id`, `updated_at desc, id desc` | `(tenant_id, user_id, updated_at desc, id desc)` | One page |
| Last 12 messages of a chat | `chat_id`, `created_at desc` | `(chat_id, created_at desc)` | 12 |
| Append a message and bump `chats.updated_at` | PK | PK | 2 |
| Resolve draft lookup | full PK | PK | 1 |
| Add token use; read today's total | `tenant_id, day` | PK | 1 |
| Retention purge of messages (§11) | `created_at <` cutoff | BRIN `(created_at)` | One batch |
| Retention purge of users (§11) | `last_sign_in_at <` cutoff | None while the table is small; revisit with P-4 | Whole table |

Rules:
- No `SELECT *` on hot paths; select the columns the response needs.
- Lists use keyset pagination (`WHERE (updated_at, id) < ($1, $2)`), never `OFFSET`.
- No N+1 queries: the chat list is one query; a chat and its messages are at most two.
- Before go-live, `EXPLAIN (ANALYZE, BUFFERS)` every query in this table against a database seeded to the P-4 figures (§12). The plan must use the listed index.

---

## 5. Cache

D-003 is the rule: live queries, short cache, and nothing shown from a stored figure. Every cache key starts with the tenant id. Every cache that holds instance data also carries the user, because ServiceNow ACLs differ per user.

| What | Where | Key | Lifetime | Notes |
|---|---|---|---|---|
| Tile figures, series, breakdowns | Process memory, per task | `tenant + user + definition + period` | 3 min (`CACHE_MS`, `mockup/server.ts`) | Concurrent identical requests share one call (`inflight`) |
| Ticket evidence (Resolve) | Process memory | `tenant + user + ticket` | `<TBD>` | Dropped after a write to that ticket (architecture §7 flow 6) |
| User's ServiceNow groups | Process memory | `tenant + user` | Same as tile figures | For "my" features |
| Tenant by host, current definitions, tenant profile | Process memory, loaded from Postgres | `subdomain` / — / `tenant` | `<TBD>` | Sets how long a change takes to reach every task |
| User's ServiceNow tokens | `sessions` (encrypted) | session | Token expiry; refreshed with the refresh token | |
| Resolve drafts | `llm_output_cache` | §3 | P-8 | |

- Every in-process cache has a TTL **and** an entry cap, with the oldest entry evicted first; the cap is `<TBD>`. Per-user keys make an uncapped `Map` grow with the user count.
- Consistency between tasks is open (Q21).

---

## 6. Migrations

- **Tool:** drizzle-kit. The schema is in `apps/server/src/db/schema.ts`. `drizzle-kit generate` writes SQL to `apps/server/src/db/migrations/`. The SQL is reviewed and committed like any code.
- **Applied** by `drizzle-kit migrate` as a one-off task with the migrator role, before the new app version starts serving.
- **Forward-only** in every deployed environment. Each migration must be safe while the previous app version is still running: **expand** (add a nullable column or a new table) → deploy code that writes both → backfill → **contract** (drop the old column) in a later release.
- **Never edit an applied migration.** A mistake is fixed by a new one.
- **Backfills** run in batches, in their own migration or script, never inside a long transaction.
- **Indexes** on a populated table use `CREATE INDEX CONCURRENTLY`, in a migration of its own (it cannot run inside a transaction).
- **Things drizzle-kit does not generate** are written as SQL in the same folder: CHECK constraints it cannot express, the `definitions_current` view, role grants, the BRIN index, and the `pg_cron` jobs (§11).
- **CI** (GitHub Actions) runs every migration against an empty Postgres 16 service container, then the test suite against the result.

---

## 7. Connections and performance

- **Pool:** `pg.Pool` per task. Size it so that pool size × the maximum task count, plus headroom for migrations, `pg_cron` and an incident session, stays under the instance's `max_connections`. Task count and instance size are `<TBD>` (Q5, Q13).
- **Timeouts, set on the role so they cannot be forgotten in code:** `statement_timeout`, `idle_in_transaction_session_timeout` and `lock_timeout` on `nowops_app`; a longer `statement_timeout` on the migrator role. Values `<TBD>`.
- **Slow-query log:** `log_min_duration_statement` in the RDS parameter group, threshold `<TBD>`. Logs go to CloudWatch (architecture §16) and are reviewed against the targets in Q18.
- **TLS** to RDS is required (`rds.force_ssl = 1`), with the RDS CA bundle pinned in the container.

---

## 8. Roles and access

| Role | Can | Used by |
|---|---|---|
| `nowops_migrator` | Owns the schema; DDL | The migration task only |
| `nowops_app` | `SELECT, INSERT, UPDATE, DELETE` on tenant tables; `SELECT, INSERT` only on `definitions` and `tenant_profile_history` | API tasks |
| `rds_superuser` (master) | Everything | Break-glass only; credentials in Secrets Manager, rotated by RDS |

- Role passwords live in Secrets Manager with RDS rotation.
- No person has a standing login. A read-only console session for an incident uses a temporary role grant, recorded in the incident.

---

## 9. Backup, restore and encryption

| Item | Setting |
|---|---|
| Region | ap-south-1 (D-018); cross-region copies `<TBD: clients' data-residency terms>` |
| Encryption at rest | RDS storage encryption with a customer-managed KMS key; covers snapshots and backups |
| Encryption in transit | TLS required (§7) |
| Automated backups | On, with point-in-time recovery; retention `<TBD>` (Q16) |
| High availability | `<TBD>` per environment (Q5) |
| Deletion protection | On in production; a final snapshot on deletion |
| Restore drill | Before go-live, then on a schedule `<TBD>`: restore to a new instance, run the migration check and a smoke test, record the time taken against the recovery targets (Q18) |

Deleted data stays in backups until they age out. Clients are told the backup retention as part of the offboarding terms.

---

## 10. Tenancy

- **One database and one schema for all tenants** (D-018). Every tenant-scoped table carries `tenant_id` (§2).
- **Every repository function takes `tenantId` as its first argument** and puts it in the `WHERE` clause. The tenant comes from the host and is checked against the session (architecture §6); it never comes from a request parameter.
- **Composite foreign keys** (§2) stop a cross-tenant reference from being written at all.
- **Isolation test** in CI: seed two tenants with users, chats, a profile and cached drafts. Call every repository function as tenant A and assert that no tenant B row comes back. A new repository function without a case in that test fails review.
- **Row-level security is not used now.** Bring it in if a client requires stronger isolation or an isolation defect is found (D-018, "Revisit when"). Because every table already has `tenant_id`, it is then a policy per table plus `SET app.tenant_id` per transaction, with no schema change.

---

## 11. Retention and deletion

Retention purges run as **`pg_cron` jobs inside Postgres** (supported on RDS PostgreSQL 16 through the parameter group). They are created by migration and delete in batches. There is no scheduler in the application (D-008); this is SQL on a timer.

| Data | Keep for | How deleted |
|---|---|---|
| `sessions` | Idle and absolute timeouts `<TBD>` (Q8) | `connect-pg-simple` prunes expired rows; sign-out deletes the row, and revokes the ServiceNow token if a revoke endpoint exists (architecture §20 F2) |
| `invites` | `<TBD>` (Q16) | `pg_cron` daily, used or expired invites past retention |
| `chat_messages` | `<TBD>` from `created_at` (Q16) | `pg_cron` daily: delete in batches by `created_at` |
| `chats` | While it has messages | The same job deletes chats left with no messages |
| `users` | `<TBD>` after last sign-in (Q16) | `pg_cron` daily; their chats cascade |
| `tenant_profile_history` | `<TBD>` (Q16) | `pg_cron` daily |
| `llm_output_cache` | Time backstop `<TBD>` (P-8) | `pg_cron`; reads also ignore expired rows |
| `llm_usage` | `<TBD>` (Q16) | `pg_cron` monthly |
| `definitions` | Kept, all versions | Never deleted |
| `tenants`, `connections`, `tenant_profile` | Until offboarding | Offboarding, below |
| Backups | `<TBD>` (Q16) | Aged out by RDS (§9) |
| CloudWatch logs | `<TBD>` (Q16) | Log group retention (architecture §16) |

**Removing one user** (on request, or for a client's erasure request): delete the `users` row, which cascades to their chats and messages. Then delete their sessions: `DELETE FROM sessions WHERE sess->>'userId' = $1`.

**Offboarding a tenant:**
1. Set `tenants.status = 'suspended'`. Sign-in stops at once.
2. Delete their sessions: `DELETE FROM sessions WHERE sess->>'tenantId' = $1`.
3. `DELETE FROM tenants WHERE id = $1`, which cascades to every tenant-scoped table.
4. Delete the OAuth client secret and any client LLM key in Secrets Manager.
5. Remove the subdomain DNS record and the egress allowlist entries (instance host, client LLM host).
6. Backups age out within the backup retention window. Confirm the date to the client.

---

## 12. Capacity plan

The figures wait on P-4 (tenants and users in year one) and on the chat retention (Q16). The method:

- **`chat_messages` is the table to watch.** Its live size ≈ active users × messages per user per working day × working days in the retention window. Each question makes two messages. Row size is the answer plus its trace.
- Everything else is small: one row or a few per tenant or user.

| Metric | Trigger to act | Action |
|---|---|---|
| Database size | `<TBD>` share of allocated storage | RDS storage autoscaling with a maximum `<TBD>`; check the trace size if growth is faster than the formula |
| `chat_messages` rows | Row count or daily purge time `<TBD>` | Partition by month on `created_at`; the purge becomes `DROP PARTITION` |
| CPU | `<TBD>` | Read the slow-query log first, then move up an instance size |
| Connections | `<TBD>` share of `max_connections` | Lower the pool per task, or add RDS Proxy |
| Hot query latency | `<TBD>` on any query in §4 | `EXPLAIN ANALYZE`, then fix the index |
