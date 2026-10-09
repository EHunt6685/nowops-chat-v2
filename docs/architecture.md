# NowOps Standalone — Architecture

**Status:** draft for review · **Date:** 2026-10-08 · **Owner:** NowOps team
**Companion documents:** `docs/decisions.md` (authoritative for every D-xxx and P-x cited here), `docs/database.md`, `docs/security.md`, `docs/design-system.md`.

## How to read this document

Every statement has a source:

| Tag | Source |
|---|---|
| **[A]** | An answer from the product owner (dated) |
| **[C]** | The code, at the named file (commit `bf26757`) |
| **[D]** | An entry in `docs/decisions.md` |
| **[P]** | A design proposal made by this document, for review. Not yet agreed |

Anything without one of these is written **`<TBD>`** and has a row in §19 Open questions, with who should answer it. ServiceNow behaviour that has not been checked is listed in §20 Facts to verify, and nothing else in the document relies on it.

---

## 0. Decisions and answers this architecture rests on

| Ref | Decision |
|---|---|
| D-001 | ServiceNow only; all ServiceNow code in one place; no copy of client ticket records (exception: D-017) |
| D-003 | Live queries, cache of a few minutes, no sync database |
| D-004 | NowOps owns every KPI definition, stored as data |
| D-005 | Tiles built once for every client; what each instance has switches them on |
| D-006 | Standard ServiceNow fields only |
| D-008 | No confirm step, no scheduled rescan; tiles with nothing to show hidden; admins correct, never approve |
| D-009 | Settings behind the gear |
| D-010 | Definitions audited and corrected; the audit repeated when a client connects |
| D-011 | Nothing about any one instance in code |
| D-012 | A chart under a tile runs the tile's query |
| D-013 | The page holds no figures; every number read from the instance |
| D-014 | Release 1: dashboards, assistant and Resolve with writes; users are whoever the client's instance signs in; every call as the user; no audit table |
| D-015 | The assistant answers with read-only tools |
| D-016 | Onboarding by invite (who the scan runs as is open) |
| D-017 | Stored chats and drafts may quote ticket text (retention open) |
| D-018 | One shared deployment on AWS ap-south-1, public behind AWS WAF |

**Owner answers not recorded as decisions**

| Date | Answer |
|---|---|
| 2026-10-01 | NowOps follows the same infrastructure and security protocols as NowStudio |
| 2026-10-08 | LLM per tenant: the UST gateway or the client's own (P-10); the client endpoint's interface is not decided |
| 2026-10-08 | Front end: React, Vite, Tailwind mapped to the design-system tokens, shadcn/ui, Recharts, TanStack Query |
| 2026-10-08 | Node.js 24 LTS; code on GitHub with GitHub Actions |
| 2026-10-08 | Periods and months are bucketed on UTC calendar bounds (D-011); a dark theme is kept (D-009) |
| 2026-10-08 | Values nobody has given stay `<TBD>` with a question |

---

## 1. Context

**What the system does.** NowOps gives the staff who work on a client's ServiceNow instance the NowOps dashboards (SDM QBR, Application 360, Backlog Beacon), the NowOps Assistant, and the Resolve fulfiller page, against that instance [D-014]. Those staff are the client's own people and UST staff who hold an account on that instance [A]. They sign in on the client's subdomain through the instance itself, and so through the client's SSO. Every read and every write runs as the signed-in user, so ServiceNow's ACLs decide what each person sees and can change [D-014, D-018]. Every figure is shown with the query that produced it and a link to the records it counted [D-004, D-013]. Nothing is installed in the client's instance except an OAuth application record and, where the client uses it, a `nowops_admin` role [A].

**Not in release 1** [A 2026-10-08]: a separate UST login, and a view across clients.

**Starting point:** an existing mockup and proof.

| Area | Verdict |
|---|---|
| Server domain logic: definitions engine, tool loop and its guardrails, ServiceNow client, Resolve ranking, evidence and write whitelist | Keep [P] |
| `mockup/server.ts` (1,022 lines: routes, scan, cache, Resolve) [C] | Split into features (§5) [P] |
| Front end, `mockup/public/app-preview.html` [C] | Rewrite in React [A]. It uses `innerHTML`, an inline handler and Google Fonts [C], which conflict with the CSP in §13 |
| Identity, tenancy, persistence | Build; none exists [C] |

**Constraints**

| Constraint | Value |
|---|---|
| Team size, timeline, budget | `<TBD>` (Q1) |
| Hosting | AWS ap-south-1 [A] |
| Infrastructure and security protocol | Same as NowStudio [A 2026-10-01]. Its posture includes no public surface and default-deny egress through a squid allowlist |
| Network exposure | Public internet behind AWS WAF [A]. This is a **deviation** from that posture and needs UST security sign-off (Q2) |
| Identity | Each client's ServiceNow instance (OAuth authorization code), which delegates to the client's SSO [A]. No UST identity path in release 1 [A] |
| LLM | Per tenant: the UST LiteLLM gateway, or the client's own endpoint [A]. Client endpoint interface `<TBD>` (Q4) |
| Environments | `<TBD>` (Q5) |
| Domain name | `<TBD>` (Q6) |

---

## 2. What exists today

From the code at `bf26757` [C].

| Area | Today | What the product needs |
|---|---|---|
| Runtime | TypeScript 7 run with `tsx`, no build (`tsconfig.json` `noEmit`). `.nvmrc` says 22 | Node 24 LTS [A]; a compiled build for containers [P] |
| HTTP | Express 5; `express.json({ limit: '64kb' })` on the chat app (`src/server.ts`); errors returned as `{ error: string }` | The middleware chain in §6 [P] |
| Outbound | Built-in `fetch`, 10 s timeout (`TIMEOUT_MS`, `src/servicenow/client.ts`); Anthropic SDK | Routed through the squid proxy [A 2026-10-01] |
| Config | zod schema that fails at boot (`src/config.ts`); one ServiceNow instance from `.env` | Instance per tenant from the database |
| Secrets | `.env`; the gateway key is the value of the Key Vault secret `codon-kvs` (`.env.example`); ServiceNow refresh token produced by PowerShell scripts | Secrets Manager [P]; which gateway key `<TBD>` (Q3) |
| State | In-process `Map`s: chat history trimmed to 12 entries (`src/server.ts`), figure cache, the tenant profile as one global object (`mockup/server.ts`) | Postgres (§15) [P] |
| Auth | None. One shared service credential reads and writes for everyone. The page keeps a signed-in name; a "Working as…" picker chooses the user, and `/api/chat` trusts `context.user` for "my" questions | Sign-in with the client's ServiceNow; per-user tokens; identity from the session [A] |
| Writes | `/api/resolve/write` (`mockup/server.ts`): a fixed set of actions, each a whitelisted body; dry run unless `RESOLVE_WRITES=true`; the work note names the person because ServiceNow only sees the service credential | Writes as the user [A]; confirm-before-commit [A] |
| Front end | One HTML file with hand-drawn SVG charts and `localStorage` state | React stack [A]; `docs/design-system.md` |
| Logging | `log()` writes one JSON line; `mask()` shortens keys (`src/log.ts`) | Per-request context and redaction [P] |
| Tests | vitest, 11 files, 121 cases; `tools/eval.ts` with fixtures in `tests/fixtures` | Run in GitHub Actions [A] |

**Domain logic to carry over** [C]:
- definitions with placeholders resolved from the scan (`src/definitions.ts`);
- the tool loop and its number-grounding check (`src/llm/agent.ts`, `src/tools/*`);
- the table allowlist and the denied tables and fields (`src/tools/tables.ts`);
- the field-existence probe;
- the encoded-query shape check (`src/servicenow/stats.ts`);
- single-flight token refresh (`src/servicenow/client.ts`);
- Resolve ranking rules with their queries, and the write whitelist (`mockup/server.ts`);
- the connection-time checks (`/api/checks`, D-011).

---

## 3. System diagram

```
  Internet                                                    │  AWS ap-south-1, NowOps VPC
                                                              │
  Browser (client staff, UST staff with a client account)     │
     │                                                        │
     ├──HTTPS──► <client>.nowops.<domain> ───────────────────►│──► AWS WAF ──► load balancer (TLS)
     │                                                        │                   │
     │  sign-in redirect                                      │                   ▼  private subnets
     ▼                                                        │            API tasks (ECS Fargate) [P]
  <instance>/oauth_auth.do ──► client's SSO                   │            Express: API + built SPA
                                                              │              │         │          │
                                                              │              ▼         ▼          ▼
                                                              │         PostgreSQL  Secrets    Logs and
                                                              │         (RDS) [P]   Manager    metrics
                                                              │                     [P]        [P]
                                                              │              │
                                                              │              ▼
                                                              │      squid egress proxy (allowlist) [A]
 ─────────────────────────────────────────────────────────────┼──────────────┼──────────────────────────
  Trust zone: client                                          │              ├──► <instance> (one per tenant)
  Trust zone: LLM provider (UST gateway or the client's own)  │              ├──► UST LLM gateway (private DNS)
                                                              │              └──► client's own LLM endpoint
                                                              │                   (per tenant, if used)
```

Three trust boundaries:
1. **Client instance:** the signed-in user's ServiceNow account and its ACLs.
2. **NowOps (UST-hosted):** the session, the host-to-tenant check and tenant scoping.
3. **LLM provider:** the UST gateway under UST's model agreements, or the client's own endpoint under terms `<TBD>` (Q4). What crosses this boundary is listed per flow in §7.

The compute, database and secrets boxes are [P]. They are AWS services in ap-south-1 [A] in the shape NowStudio uses, and are not yet confirmed for NowOps.

---

## 4. Components

| Component | Responsibility | Data it owns |
|---|---|---|
| Web client | Pages, routing, polling and caching (TanStack Query) [A] | None |
| API server | Tenant from host, session, validation, authorisation, response shaping [P] | None, apart from the in-process figure cache |
| Tenant onboarding | Tenant record, invite, activation (§7 flow 2) [A] | Tenants, invites, connections |
| Definitions engine | Definitions as data; placeholder resolution from the tenant profile; definitions, ratios, breakdowns [C, D-004, D-012] | Reads definitions and profile |
| Instance scan | Tables present, state classes, SLA match, time zone, automation candidates, connection-time checks [C, D-011] | Writes the tenant profile |
| Assistant | Tool loop (§7 flow 4) [C] | Chats and messages |
| Resolve | Queue ranking, ticket evidence, drafts, and the write path (§7 flows 5 and 6) [C, A] | Model-output cache (P-8) |
| ServiceNow client | Built per request from the tenant's instance URL and the user's token [A]; 10 s timeout, typed unavailable error, single-flight refresh [C] | None |
| LLM client | Per tenant: UST gateway or the client's endpoint [A]; boot preflight and stub mode [C] | None |
| PostgreSQL | NowOps' own data only (§15). ServiceNow stays the system of record for tickets [D-001, D-003] | Yes |
| Background jobs | None in the application [D-008]. Retention purges run as `pg_cron` SQL jobs inside PostgreSQL (`docs/database.md` §11) [P] | — |

---

## 5. Code layout [P]

```
apps/server/src/
  features/
    auth/         # ServiceNow OAuth sign-in, callback, sign-out, token refresh, session
    onboarding/   # tenant creation, invite, activation
    tenancy/      # tenants, connections, users, /api/me
    dashboard/    # dashboard, series, breakdown, checks, places, services, graph, list
    definitions/  # catalogue, placeholder resolution, scan, profile
    chat/         # /api/chat, tool loop, tools
    resolve/      # queue, ticket, steps, brief, draft, write
  integrations/
    servicenow/   # the only code that knows ServiceNow (D-001)
    llm/          # UST gateway client, client-endpoint client, preflight, stub
  middleware/  config/  db/
apps/web/src/     # React app [A]: tokens, components, pages, typed API client
packages/shared/  # request and response types used by both sides
```

- Dependencies point inward: routes call services, services call `db/` and `integrations/`.
- Dependencies are passed in, as `makeApp({ cfg, sn, kpis, agent, … })` does today [C], so tests run without a network.

---

## 6. Request lifecycle [P]

1. Request id.
2. Logger with the request id.
3. Security headers and a per-request CSP nonce.
4. Body size limit (the chat app uses 64 kB today [C]).
5. **Tenant from host.** Unknown or disabled host → 404, before any session work.
6. **Session.** No session on an API route → 401; on a page → redirect to the tenant's ServiceNow sign-in. The session's tenant must equal the host's tenant.
7. Logger enriched with tenant and user.
8. CSRF origin check on state-changing methods. The OAuth callback is protected by `state` (and PKCE if supported, §20).
9. Schema validation (zod).
10. Authorisation: `admin` for Settings and overrides; `member` for the rest.
11. **Rate limits per user**, after sign-in, on the assistant, drafts and writes. Limits by IP are left to the WAF, because a client's staff may share one NAT address. Values `<TBD>` (Q7).
12. **Confirm-before-commit** on write routes (§7 flow 6).
13. Handler.
14. Error response. Today `{ error: string }` [C]; any change is `<TBD>` (Q20).

A decline ("no definition matches", "not available on this instance") is a normal answer with a reason, not an error [C].

---

## 7. Data flows

Each flow states the source of truth, caching, behaviour when a dependency is down, what reaches the model, and what is logged.

### Flow 1: Sign-in and routing [D-014, D-018]

1. The browser opens `https://<client>.nowops.<domain>/`. The host gives the tenant. No session → redirect to `<instance>/oauth_auth.do` with the tenant's OAuth client id, `state`, and the callback `https://<client>.nowops.<domain>/auth/sn/callback`.
2. The instance shows its own login, which hands off to the client's SSO where it is federated. NowOps sees no password and no SSO assertion.
3. The instance redirects to the callback with a code. The server checks `state` and exchanges the code at `<instance>/oauth_token.do` for this user's access and refresh tokens.
4. With the user's token the server reads the user's `sys_user` record and roles. Admin if the user holds `admin` or `nowops_admin` [A]; otherwise member. Whether a non-admin user can read their own roles is in §20.
5. A server-side session is created holding the user id and the user's encrypted tokens [P].
6. `GET /api/me` → user, role, tenant and whether the tenant is active and its profile ready. Routing:
   - tenant not active → "your ServiceNow admin has not finished setting up NowOps";
   - otherwise → dashboard.

UST staff with an account on the instance follow exactly this flow [A]. A person working on two clients signs in on each subdomain separately.

| | |
|---|---|
| Source of truth | The client instance (identity, roles, access); PostgreSQL for sessions |
| Cached | Session lifetime `<TBD>` (Q8); role re-read at each sign-in |
| Dependency down | Instance down → no sign-in and no figures for that tenant only |
| Reaches the model | Nothing |
| Logged | Sign-in, sign-out, failed callback, refresh failure |

"My" features use the `sys_id` from step 4 [A]. The "Working as…" picker and `context.user` from the browser are removed.

### Flow 2: Onboarding a client [A 2026-10-08]

1. **UST creates the tenant:** subdomain and the client's instance host. How the UST person does this (an operator page or a script, and how they sign in) is `<TBD>` (Q9).
2. **UST adds the instance host to the squid allowlist** before the invite is sent. A client cannot change the host later without UST. If the client's instance restricts inbound IP addresses, NowOps' egress address must be on the client's list (Q19).
3. **UST issues the invite:** a single-use link, valid for 7 days. How it is delivered and stored is [P]: stored as a hash, sent to the client's named contact.
4. **The client's ServiceNow admin** creates an OAuth application on their instance with the NowOps callback URL, and the `nowops_admin` role if they choose to use it instead of `admin`.
5. The admin opens the invite and enters the instance URL, which must match the recorded host, and the OAuth client id and secret. The secret is stored in Secrets Manager [P].
6. **Reachability probe.** Three distinct messages:
   - the egress proxy refused the host;
   - the token endpoint refused the client;
   - the instance did not answer.
7. The admin signs in through the instance (flow 1). They must hold `admin` or `nowops_admin`; otherwise activation is refused and the invite stays usable until it expires.
8. The tenant becomes active; the invite is spent.
9. **First scan** with the admin's token (D-008, D-011, D-010 checks), which writes the tenant profile. The admin lands on the dashboard. Members can now sign in.

**Who the scan runs as [P].** The profile describes the instance, and a member's narrower ACLs could hide parts of it. So the scan runs with an admin's token: at activation, and when an admin's request finds the profile older than the tenant cache lifetime (D-008), de-duplicated across concurrent requests (the `inflight` pattern [C]). Members use the current profile. Before the first scan completes, figure routes answer 409 [C, D-013].

| | |
|---|---|
| Source of truth | The client instance; PostgreSQL holds the derived profile and overrides |
| Dependency down | Instance down → shown on connection health; no stored figure is shown (D-013) |
| Reaches the model | Nothing |
| Logged | Tenant created, invite issued, invite used or expired, activation refused, secret changed, scan run |

### Flow 3: Dashboard tile load

1. The page asks for `/api/dashboard`, `/api/series` and `/api/breakdown?def=…` with the period [C, D-012].
2. Placeholders are resolved from the tenant profile; the period applies to each definition's own date field [C].
3. Tiles run through the ServiceNow stats API **with the user's token** [A], at most 6 at a time [C], through the figure cache.
4. Each tile returns value, basis, resolved query and a link. Tiles with nothing to show are hidden [D-008, D-011].

| | |
|---|---|
| Cached | In-process, a few minutes [D-003]. The key includes **tenant and user** [P], because ACLs differ: two users can correctly see different numbers |
| Dependency down | Tile shows "unavailable" with the reason; never zero, never a stored figure [D-005, D-013] |
| Reaches the model | Nothing |
| Logged | Each query sent to the instance: tenant, user, table, query, result size |

A per-user cache means N users opening the same dashboard send N sets of tile queries to the instance. The effect is measured per tenant before any wider cache key is considered [P].

### Flow 4: Assistant question [C]

1. `POST /api/chat` with the question, chat id and page context. The user comes from the session [A].
2. Token guard: fewer than two meaningful words → declined with no network call (`src/guard.ts`).
3. Tool loop (`src/llm/agent.ts`): up to 6 tool calls (`STEP_BUDGET`), temperature 0. Tools: `run_definition`, `count`, `aggregate`, `list_records`, `resolve_reference`, `describe_table`, `list_choices`, `validate_query`, `search_knowledge`, `get_article`, `get_ticket`, `my_queue`, `ask_user`.
4. Every tool runs on the server as the user [A]. The guardrails [C]:
   - table allowlist plus the scanned tables;
   - denied tables and fields;
   - field-existence probe;
   - query shape check;
   - sys_ids only from this question's lookups;
   - at most 25 rows per list.
5. Every number in the answer must appear in a cited tool result. There is one retry naming the ungrounded numbers.
6. The response carries the answer, its sources, and a trace of tool calls with queries and verify links.

The assistant has **no write tools** [C]. Writes happen only on the Resolve page (flow 6).

| | |
|---|---|
| Cached | Chat history in PostgreSQL [P]; the last 12 entries used as context [C] |
| Dependency down | LLM down → assistant unavailable; dashboards unaffected |
| Reaches the model | The question, recent messages, the definitions catalogue, and tool results: counts and aggregates; up to 25 rows per list (allowed fields only); for `get_ticket`, the ticket's fields including description and close notes, its latest 8 journal entries, look-alikes' close notes and matching articles; knowledge article text [C] |
| Logged | Each tool call with its arguments and query, cited result ids, steps, latency, token usage [C] |

### Flow 5: Resolve ticket and draft [C]

1. `GET /api/resolve/ticket/:number` reads the ticket, SLAs, journal, look-alikes and matching articles, as the user [A].
2. `POST /api/resolve/steps|brief|draft/:number`: the model arranges the supplied facts. If the model fails, rule-based text is used and labelled.
3. Model output may be cached by tenant, ticket and `sys_updated_on` (P-8, open). A cached draft is served only after step 1 has read the ticket as the current user [P].

| | |
|---|---|
| Reaches the model | The ticket's fields, journal entries, look-alikes' close notes, article titles and text |
| Logged | Each model call with its input size and whether rules were used |

### Flow 6: Resolve writes [A 2026-10-08]

Release 1 has every write the mockup has (`mockup/server.ts` `/api/resolve/write`) [C, D-014]:
- claim;
- reassign to a group or person;
- hold with a reason;
- resolve (incident) or close complete / incomplete (request item);
- work note;
- comment;
- approve or reject an approval on a request item;
- knowledge article draft;
- problem record;
- record fixes (`cmdb_ci`, `assignment_group`, `assigned_to`, `category` only).

The full table is in D-014.

**Known gap against D-011.** The mockup writes fixed state numbers: resolve sets incident state 6, claim moves state 1 to 2, hold sets 3, and request items close with 3 or 4 [C]. D-011 says no state number is assumed. The write path must take these values from the scanned state classes before release (Q10).

1. The user picks an action on the Resolve page. The server builds the exact PATCH or POST body from the whitelist [C].
2. **Confirm-before-commit** [A]: the page shows the record, the fields and values that will change, and the target table. Nothing is sent until the user confirms. How the confirmation is bound to the request (for example a short-lived token tied to that exact body) is [P].
3. The request goes to ServiceNow **with the user's token** [A]. ServiceNow's own history (`sys_audit`, the journal, `sys_updated_by`) records the real user. NowOps keeps no audit table [D-014]. The mockup's "via NowOps by <name>" note exists only because of the shared credential [C], and can go.
4. On success the ticket's and queue's cache entries are dropped [C].
5. The `RESOLVE_WRITES` dry-run switch [C] is kept for non-production use [P].

The OAuth scope that permits exactly these writes is `<TBD>` (Q11).

| | |
|---|---|
| Source of truth | The client instance |
| Dependency down | The write fails with the instance's message; nothing is retried [C] |
| Reaches the model | Nothing at write time. A draft text the user confirms may have come from flow 5 |
| Logged | Action, record, table, fields changed (not values), result |

### Flow 7: Tenant LLM [A 2026-10-08]

- **UST gateway:** Anthropic SDK with the gateway base URL and key [C]. A per-tenant daily token budget applies, with fallback to rules (P-10). Whether a per-user cap is also needed is open (P-10).
- **Client's own LLM:** a per-tenant endpoint and key. The key is stored in Secrets Manager [P]; the endpoint's host is on the squid allowlist, added by UST like the instance host [A]. No NowOps token cap (P-10). Interface, security and data terms are `<TBD>` (Q4). The tool loop is written against the Anthropic Messages API [C], so anything else needs an adapter and its own evaluation.
- In both cases the boot preflight [C] runs per configured endpoint [P], so a wrong model id fails loudly.

---

## 8. Stack

| Layer | Choice | Version | Source |
|---|---|---|---|
| Runtime | Node.js | 24 LTS | [A] |
| Language | TypeScript, strict | ^7.0.2 | [C] |
| HTTP | Express | ^5.2.1 | [C] |
| Validation | zod | ^4.6.5 | [C] |
| LLM SDK | `@anthropic-ai/sdk` | ^0.125.0 | [C] |
| Tests | vitest; `tools/eval.ts` | ^5.0.0 | [C] |
| Dev runner | tsx | ^4.23.13 | [C] |
| Front end | React, Vite, Tailwind (mapped to `tokens.css`), shadcn/ui, Recharts, TanStack Query | pin at scaffold | [A] |
| Repo and CI | GitHub, GitHub Actions | — | [A] |
| Hosting | AWS ap-south-1 | — | [A] |
| Compute | ECS Fargate | — | [P] |
| Database | PostgreSQL on RDS; drizzle-orm and migrations; `pg` | pin at scaffold | [P], used by `docs/database.md` |
| Sessions | Server-side, stored in PostgreSQL | pin at scaffold | [P] |
| Secrets | AWS Secrets Manager | — | [P] |
| Edge | AWS WAF in front of the load balancer | — | [A] |
| Egress | squid proxy with a host allowlist | — | [A 2026-10-01, 2026-10-08] |
| Logging | pino with redaction | pin at scaffold | [P] |
| Security headers | helmet | pin at scaffold | [P] |
| Sign-in | OAuth 2 authorization code against the client's ServiceNow | — | [A] |
| CI checks | Type check, unit tests, eval; secret and dependency scanning (gitleaks and trivy, as NowStudio) | — | [A 2026-10-01] for the protocol; tools [P] |

---

## 9. Not in release 1

| Item | Source | Brought back when |
|---|---|---|
| Jira or any second platform | D-001 | A second platform is contractually real |
| Separate UST login and a cross-client portfolio view | A 2026-10-08 | `<TBD>` (Q12) |
| Snapshot of a chart | D-003 | That chart is measured too slow to serve live |

---

## 10. Running cost

Every figure is `<TBD>` (Q13). It depends on the environments (Q5), the number of tenants and users (P-4), and whether the network and egress components are shared with NowStudio.

| Item | Per environment |
|---|---|
| Compute | `<TBD>` |
| Database | `<TBD>` |
| Load balancer and WAF | `<TBD>` |
| NAT and squid egress | `<TBD>` |
| Secrets Manager | `<TBD>` |
| Logs and metrics | `<TBD>` |
| Backups | `<TBD>` |
| LLM usage on the UST gateway | `<TBD>` (chargeback model unknown, Q13) |
| LLM usage on a client's own endpoint | Paid by the client [A, P-10] |

An assistant question can make up to 7 model calls: 6 tool steps and one grounding retry [C].

---

## 11. Integrations

| System | Direction | Auth | Allowlist entry | Timeout | Failure behaviour |
|---|---|---|---|---|---|
| Client ServiceNow (per tenant) | Sign-in; read and write as the user [A] | OAuth authorization code; per-user tokens [A]; OAuth client created by the client's admin [A] | Instance host, added by UST at tenant creation [A] | 10 s [C] | "Unavailable" with reason; "Invalid table" read as "not installed" [C, D-011]; never zero or full-table [D-005] |
| UST LLM gateway | Request / response | Gateway key (which key: Q3) | Gateway host, private DNS [A 2026-10-01] | `<TBD>` | Assistant unavailable; Resolve uses rules [C] |
| Client's own LLM (per tenant, optional) | Request / response | `<TBD>` (Q4) | Endpoint host, added by UST [A] | `<TBD>` | Same as the gateway |
| Secrets Manager | Read; write at onboarding | Task role [P] | — | — | Onboarding step fails with a message |

Rate limits of each client instance and of the gateway: `<TBD>` (Q14).

---

## 12. AI / LLM

Facts from the code [C]:
- Base URL, key and model id come from configuration, not code.
- A boot preflight fails start-up if the model does not answer.
- Stub mode exists and is labelled.
- The model supplies tool arguments, never requests. Server code checks the table, fields, query shape and sys_ids before anything runs.
- Every number in an answer must appear in a cited tool result; article citations map to articles actually returned. Ungrounded output is refused after one retry.
- The system prompt is cached (`cache_control` in `src/llm/agent.ts`).
- Evaluation: `tools/eval.ts` with routing, metric, retrieval and resolve fixtures.

Requirements and open items:
- **Personal data.** Organisation policy forbids processing national identity numbers, passport and licence numbers, card numbers and patient records. Denied fields keep structured fields out [C]. Free text in tickets can still contain them, so masking on the path to the LLM is required. Where it is applied (gateway or NowOps) and whether the gateway offers it are `<TBD>` (Q15). For a client's own LLM, the same question is part of Q4.
- **Untrusted text.** Ticket text and articles reach the model. The tool loop is read-only [C] and the assistant cannot write, so injected instructions can at most cause reads the user could already make.
- **Budget:** per-tenant on the UST gateway; per-user cap open (P-10).
- **Evaluation in CI** on GitHub Actions [A]. Running against the gateway needs a key in CI (Q3).

---

## 13. Security

Measured against the NowStudio protocol [A 2026-10-01].

| Requirement | NowOps |
|---|---|
| No public surface | **Deviation:** public, behind AWS WAF [A]. Unknown hosts rejected before any app logic [P]. Every route needs a session except sign-in, the invite page and a health check [P]. Needs UST security sign-off (Q2) |
| Default-deny egress | squid allowlist: each tenant's instance host, the UST gateway, and any client LLM host. All added by UST [A] |
| SSO | The client's SSO through its ServiceNow sign-in [A]. NowOps stores no passwords. No other sign-in path in release 1 [A]. How UST creates tenants (Q9) must not add an unreviewed one |
| Sessions | Server-side; httpOnly, Secure, host-only cookie per subdomain [P]; timeouts `<TBD>` (Q8). The user's ServiceNow tokens are encrypted at rest [P] |
| Writes | As the user [A]; whitelisted actions and fields [C]; confirm-before-commit [A]; OAuth scope `<TBD>` (Q11) |
| Invite | Single use, 7 days [A]; stored as a hash, compared in constant time, spent on activation [P] |
| CSP and XSS | Script nonce, no inline scripts; no font or script loaded from a third party (Aptos where installed, Arial fallback, `docs/design-system.md` §2.4); React escaping, no raw HTML from instance or model text [P] |
| CSRF | Origin check on state-changing requests; OAuth `state` [P] |
| Secrets | Never in the browser or logs; `mask()` [C]; redaction in the logger [P] |
| Tenant isolation | Tenant from host, equal to the session's tenant; tenant id on every row and cache key; a user's token only reaches their own tenant's instance [P] |
| Least privilege | Each call runs with the user's token, so NowOps never shows or changes more than the user can in ServiceNow [A]. Table allowlist and denied fields apply on top [C] |
| Data held | No ticket rows. Chat messages and Resolve drafts can quote ticket text: the D-001 exception (§0) |
| Audit | No NowOps audit table [D-014]. ServiceNow records changes against the user. NowOps' own admin changes carry who and when on the row [P] |
| Supply chain | Secret and dependency scanning in GitHub Actions [A 2026-10-01, A 2026-10-08]; only `.env.example` committed [C] |

---

## 14. Tenancy and identity

- **Tenant** = one client = one ServiceNow instance = one subdomain [A].
- **One shared deployment** [D-018]. Tenant id on every tenant-scoped row [P].
- **Users** are whoever the instance signs in: client staff, and UST staff with an account there [A]. A user row is keyed by tenant and ServiceNow `sys_id` [P]. NowOps has no invite or user-management screens for members.
- **Roles.** `admin` = holder of ServiceNow `admin` or `nowops_admin` [A]; everyone else is `member`. Roles are re-read at every sign-in [P].
- **Removing access** happens in the client's ServiceNow or SSO. How quickly an existing session stops depends on the access-token lifespan (§20).
- **What a user sees and changes** is bounded by their own ServiceNow access [A].

---

## 15. Data held by NowOps

Schema detail is in `docs/database.md`.

| Data | Notes | Retention |
|---|---|---|
| Tenants, invites, connections | Subdomain, instance host, OAuth client id, secret reference, LLM endpoint choice | `<TBD>` (Q16) |
| Users | Tenant, `sys_id`, name, email, role, last sign-in | `<TBD>` (Q16) |
| Definitions | Global, versioned [D-004] | Kept |
| Tenant profile and its history | [D-008, D-011] | `<TBD>` (Q16) |
| Chats and messages | Can quote ticket text (D-001 exception) | `<TBD>` (Q16) |
| Model-output cache | P-8, open | `<TBD>` (P-8) |
| LLM usage | Per tenant per day, for the budget (P-10) | `<TBD>` (Q16) |
| Sessions | Include the user's encrypted tokens [P] | Session lifetime (Q8) |

Not stored: ticket rows, record lists, passwords.

---

## 16. Observability

- Logs: one JSON line per event with request id, tenant and user [P]. Existing event names kept: `chat.tool`, `chat.tool_rejected`, `chat.ungrounded_retry`, `chat.agent`, `sn.token.refreshed`, `llm.preflight.ok` [C].
- Alarms on: preflight failure; a tenant's instance not answering; a tenant's token endpoint refusing the OAuth client; sign-in failures; rejected tool calls and ungrounded answers per tenant; token budget per tenant [P]. Thresholds `<TBD>` (Q17).
- Security events: denied tables or fields, sys_ids not from this question's lookups, CSRF rejections, bad OAuth `state`, host and session tenant mismatch, invite misuse [P].
- Log retention `<TBD>` (Q16).

---

## 17. Non-functional targets

All `<TBD>` (Q18): dashboard load time, assistant answer time, availability, recovery point and time, tenants and users per tenant (P-4).

---

## 18. Risks

| # | Risk | Source | Mitigation |
|---|---|---|---|
| R1 | Each new client needs a squid entry and DNS before onboarding | A 2026-10-08 | UST adds the host at tenant creation, before the invite |
| R2 | The client rotates the OAuth secret or deletes the application, and nobody at that client can sign in | Flow 2 | Alarm on token-endpoint refusals per tenant; the setup sheet tells the admin to update NowOps when rotating [P] |
| R3 | Today the browser supplies the user's identity | C (`src/server.ts` `parseContext`) | Identity from the user's own token (flow 1) |
| R4 | Figures cached per task can differ between tasks for the cache lifetime | D-003 with more than one task [P] | Measure; options `<TBD>` (Q21) |
| R5 | The gateway renames or retires a model id | C (`.env.example`, preflight) | Boot preflight; id in configuration |
| R6 | ServiceNow ignores an unknown field and returns the whole table | D-005 | Field-existence probe [C] |
| R7 | Ticket free text carries personal data to the LLM | C (flow 4) | Masking (Q15); denied fields [C] |
| R8 | Injected text in tickets or articles steers the tool loop | C | Read-only tools, allowlists, grounding check [C]; the assistant has no write tools |
| R9 | The app is reachable from the internet | A 2026-10-08 | WAF; unknown hosts rejected; session on every route; UST security sign-off (Q2) |
| R10 | A write is made on a wrong reading of the ticket | A 2026-10-08 (writes) | Confirm-before-commit with the exact change shown [A]; whitelist [C] |
| R11 | An invite link leaks within its 7 days | A 2026-10-08 | Single use; activation also needs `admin` or `nowops_admin` on the client's instance [A] |
| R12 | A client's own LLM sits outside UST's data terms | A 2026-10-08, P-10 | Terms agreed per client before it is enabled (Q4) |
| R13 | Per-user caching multiplies tile queries on the client instance | Flow 3 | Concurrency cap of 6 per load [C]; measure per tenant |
| R14 | A user lacks read on a table a tile needs | A (ACLs govern) | The tile says it is not readable with your access, distinct from "not installed" [P]; how to tell them apart is in §20 |
| R15 | Credentials and setup knowledge live on one laptop today | C (`.env`, PowerShell scripts) | Onboarding in the product; secrets in Secrets Manager |
| R16 | The front-end rewrite is large | C (single-file mockup) | Page by page against `docs/design-system.md`, server routes kept stable [P] |

---

## 19. Open questions

| # | Question | Who answers |
|---|---|---|
| Q1 | Team size, timeline, monthly budget | Owner |
| Q2 | Sign-off for a public, WAF-protected surface as a deviation from the NowStudio protocol; any conditions (for example per-client IP allowlists) | UST security |
| Q3 | Does NowOps get its own gateway key and model alias, or keep Codon's (`codon-kvs`, `claude-opus-4-8-Codon`)? Is a key available to CI? | Owner, platform team |
| Q4 | A client's own LLM: which interface (Anthropic-compatible only, or others), and its security and data terms (masking, region, retention) | Owner, UST security |
| Q5 | Which environments (dev, test, prod)? | Owner |
| Q6 | The domain for `<client>.nowops.<domain>` | Owner, platform team |
| Q7 | Rate-limit values: per user, and the WAF rule | Owner, UST security |
| Q8 | Session idle and absolute timeouts | UST security |
| Q9 | How a UST person creates a tenant and issues the invite, and how that person signs in | Owner |
| Q10 | How the write path gets its state values (resolved, on hold, in progress, request-item closed complete and incomplete) from the scan instead of fixed numbers, as D-011 requires | Build team |
| Q11 | The OAuth scope on the client's OAuth application that allows exactly the release-1 reads and writes | Build team, verified on the dev instance |
| Q12 | When a UST login and cross-client view come back | Owner |
| Q13 | Running cost per environment | Platform team |
| Q14 | Rate limits of client instances and of the gateway | Clients, platform team |
| Q15 | Where personal-data masking happens on the path to the LLM, and whether the gateway provides it | Platform team, UST security |
| Q16 | Retention for users, profile history, chats, usage and logs | Owner, UST policy |
| Q17 | Alarm thresholds | Owner |
| Q18 | Non-functional targets | Owner |
| Q19 | Does a client instance restrict inbound IP addresses? If so, NowOps needs a fixed egress address to give to the client | Each client |
| Q20 | Should the error response change from today's `{ error: string }`, and to what? | Build team |
| Q21 | With more than one API task, how are cached figures kept consistent between tasks (accept, sticky sessions, or a shared cache)? | Build team, owner |

---

## 20. Facts to verify

ServiceNow behaviour this design depends on but nobody has checked. Each one is to be verified with read-only calls on the dev instance before the design relies on it.

| # | Fact | Depends on it |
|---|---|---|
| F1 | ServiceNow OAuth supports PKCE on the authorization-code flow | Flow 1 step 1, §6 step 8 |
| F2 | A token revocation endpoint exists and works for user tokens | Sign-out |
| F3 | A non-admin user can read their own roles with their own token | Flow 1 step 4 |
| F4 | The access-token and refresh-token lifespans on a new OAuth application, and whether the client can set them | §14 removing access, session design |
| F5 | How the Table and Stats APIs answer an ACL denial, compared with a missing table ("Invalid table") | R14, tile states |
| F6 | Whether the scan's metadata reads (`sys_db_object`, `sys_dictionary`, `sys_choice`, `contract_sla`) succeed with an `admin` token and with a `nowops_admin` token | Flow 2 step 9 |

---

## Sources

- `docs/decisions.md`: D-001 to D-018 and the pending table.
- Code at `bf26757`: `src/`, `mockup/server.ts`, `mockup/public/app-preview.html`, `tests/`, `tools/eval.ts`, `.env.example`, `package.json`, `.nvmrc`.
- Owner answers listed in §0.
