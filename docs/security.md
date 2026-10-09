# NowOps Standalone — Security

**Status:** draft for review · **Date:** 2026-10-08 · **Owner:** NowOps team
**Companion documents:** `docs/architecture.md` (§6 request lifecycle, §7 flows, §12 LLM, §13 posture, §16 observability, §19 open questions, §20 facts to verify), `docs/database.md` (§3 schema, §8 roles, §11 retention), `docs/decisions.md`.

What this document covers: the minimum security bar NowOps must meet before a client signs in, and the rules every change is built against. It cites the architecture and the decision log rather than restating them. Where they disagree, the log wins, then the architecture, and this document is corrected. Values marked **`<TBD>`** have not been confirmed; Q-numbers refer to architecture §19 and F-numbers to architecture §20.

**Why this matters more than usual.**
- NowOps is reachable from the internet (D-018).
- Every request runs with a client user's own ServiceNow token, and release 1 writes to client records (D-014).
- A model composes queries against the client's instance (D-015).

AI-written code tends to trust the browser, leave secrets in code, skip server-side permission checks and pass input through unchecked. Each of those is a client-data incident here.

---

## 0. Go-live checklist

Every row ticked before the first client signs in. Details in the section named in the last column.

### Front end
| ☐ | Measure | What it means for NowOps | Where |
|---|---|---|---|
| ☐ | HTTPS everywhere | TLS 1.2+ at the load balancer, HTTP redirects to HTTPS, HSTS on, wildcard certificate for `*.nowops.<domain>` | §6 |
| ☐ | Output encoding | React escaping only; no `dangerouslySetInnerHTML` or `innerHTML` with instance or model text; model answers rendered as plain text | §4 |
| ☐ | Nothing sensitive in the browser | No tokens, user identity or ticket data in `localStorage` or `sessionStorage`; the session is an httpOnly cookie; the browser never holds a ServiceNow token | §2 |
| ☐ | CSRF | Origin check on every POST, PUT, PATCH and DELETE, plus SameSite=Lax; the OAuth callback is protected by `state` (and PKCE if F1 confirms it) | §6 |
| ☐ | No keys in the front end | Gateway key, client LLM keys and OAuth client secrets stay server-side; the built bundle is searched for keys in CI | §5 |

### Back end
| ☐ | Measure | What it means for NowOps | Where |
|---|---|---|---|
| ☐ | Authentication | Client and UST users sign in only through the client's ServiceNow (OAuth 2 authorization code). UST tenant creation uses the method chosen in Q9, with strong authentication and MFA. No other login path | §2 |
| ☐ | Identity from the session | User and tenant come from the session and the host name, never from the request. The "Working as…" picker, `context.user` and the `as` field are removed | §2, §17 |
| ☐ | Authorisation | Role checked on the server for every route; the session's tenant equals the host's tenant; every repository call is scoped by `tenant_id` | §3 |
| ☐ | Every route protected | Every route needs a session except those marked public in §3. Test: 401 on every other route without a session | §3 |
| ☐ | Writes | Every write is a whitelisted action, runs as the user, and is sent only after a confirmation bound to that exact change | §3 |
| ☐ | Invites | Single use, 7 days, stored only as a hash, spent on activation; activation needs `admin` or `nowops_admin` | §2 |
| ☐ | Query safety | SQL through drizzle or parameterised queries only. ServiceNow queries composed by the model pass every control in §4.2 | §4 |
| ☐ | Security headers | helmet: CSP with a per-request nonce, `frame-ancestors 'none'`, `X-Frame-Options: DENY`, `nosniff`, HSTS, `Referrer-Policy` | §6 |
| ☐ | Edge protection | Internet-facing load balancer with AWS WAF (managed rules, rate rule); unknown host names get a 404 before any app work; a maximum task count and an AWS budget alarm set | §7 |
| ☐ | Public-surface sign-off | UST security has accepted the public surface (Q2) | §7 |

### Habits
| ☐ | Measure | What it means for NowOps | Where |
|---|---|---|---|
| ☐ | Dependencies patched | Lockfile committed; `npm audit` and trivy in CI; patch window per UST vulnerability policy `<TBD>` | §11 |
| ☐ | Error handling | Users see a message and a request id; never stack traces, queries, paths, versions or instance error text | §4.6 |
| ☐ | Cookies | HttpOnly, Secure, SameSite=Lax, host-only, `__Host-` prefix, idle and absolute expiry | §2 |
| ☐ | File uploads | None in release 1 | §4.3 |
| ☐ | Rate limits | WAF by IP; per user on the assistant, Resolve drafts and writes; the invite route limited | §7 |
| ☐ | Personal data | No prohibited identifier stored, logged or sent to the model (§1); masking on the LLM path confirmed (Q15) | §8 |
| ☐ | Client LLM | A tenant's own LLM is enabled only after its terms are agreed (Q4) | §8 |
| ☐ | Pentest | Passed, findings closed or accepted in writing | §14 |
| ☐ | Disclosure contact | `security.txt` served | §15 |

---

## 1. Data classification

| Class | NowOps examples | Rules |
|---|---|---|
| **Prohibited** | National identity numbers, passport, driving licence and card numbers, patient records (organisation policy) | Never stored in any table, logged, or sent to the model. Denied fields keep structured identifiers out (`src/tools/tables.ts`). Masking of free text on the path to the LLM is `<TBD>` (Q15). A table that holds such records is excluded in the tenant's profile |
| **Secret** | Gateway key; client LLM keys; per-tenant OAuth client secrets; users' ServiceNow access and refresh tokens; session-encryption key; invite tokens; credentials of the UST tenant-creation method (Q9); database passwords | Secrets Manager, or encrypted in the session (§5). Invite tokens are stored only as a hash. Never in code, the database (except encrypted tokens in `sessions` and invite hashes), the browser, logs or error messages |
| **Client confidential** | Ticket rows, journals, articles, CMDB records, figures | Read live as the user, cached in memory for minutes, never stored (D-001, D-003, D-013). Exception: chat messages and Resolve drafts can quote ticket text (D-017), kept for the retention set in Q16 and P-8 |
| **Personal** | Users' names and emails in `users`; names in tool results | Kept to what sign-in needs; never logged; removed after the retention set in Q16 |
| **Internal** | KPI definitions, tenant profile, configuration | Normal access control |
| **Public** | Sign-in redirect, invite page shell, `security.txt` | — |

---

## 2. Authentication

**Users.** Client staff and UST staff with an account on the client's instance sign in the same way (D-014): OAuth 2 authorization code against the client's own ServiceNow, which hands off to the client's SSO (architecture §7 flow 1). NowOps never sees a password or an SSO assertion.
- `state` is random per sign-in, stored in the session and checked on the callback. If ServiceNow supports PKCE (F1), the verifier is stored the same way and checked. Otherwise `state` plus the confidential client secret are the controls.
- The redirect URI is exact (`https://<client>.nowops.<domain>/auth/sn/callback`) and registered on the client's OAuth application.
- The code is exchanged server-side with the tenant's client secret. The user's `sys_user` record and roles are read with the returned token. Admin = holder of the ServiceNow `admin` or `nowops_admin` role (D-014, D-016). Whether a non-admin can read their own roles is F3.
- The OAuth application uses the narrowest scope that allows the release-1 reads and writes (Q11).

**Invite and activation (D-016).**
- The invite token is random, sent once, and stored only as a SHA-256 hash (`docs/database.md` §3).
- The token is valid for 7 days and spent atomically on activation.
- The client's admin must enter the instance URL that UST recorded, exactly.
- Activation needs a sign-in through that instance by a holder of `admin` or `nowops_admin`. A refused activation leaves the invite usable until it expires.

**UST tenant creation.** The method is open (Q9). Whatever is chosen must:
- use strong authentication with MFA;
- be limited to creating tenants and issuing invites;
- hold no ServiceNow token, so it can read no client data;
- log every sign-in and action as a security event (§12).

There is no other local, basic-auth or bypass login.

**Sessions.** Server-side in Postgres (`express-session`, `connect-pg-simple`).
- Cookie: `HttpOnly`, `Secure`, `SameSite=Lax`, host-only (no `Domain`), `Path=/`, named with the `__Host-` prefix so the browser enforces all of that.
- Idle and absolute timeouts `<TBD>` (Q8). Session id regenerated at sign-in.
- The session holds `userId`, `tenantId`, `role` and the user's ServiceNow tokens, encrypted with AES-256-GCM under a key from Secrets Manager.
- Sign-out deletes the session, and revokes the ServiceNow token if a revoke endpoint exists (F2).
- Deactivating the user in ServiceNow or their SSO stops new sign-ins at once. When the current session stops depends on the token lifespans (F4).

**Identity.** Never taken from the browser. The user's ServiceNow `sys_id` comes from their own token at sign-in; the tenant comes from the host name. There is no "view as".

---

## 3. Authorisation

**Roles** (architecture §14):
- `member`: every signed-in user.
- `admin`: a user holding ServiceNow `admin` or `nowops_admin`, re-read at each sign-in.
- **UST tenant creation:** limited to creating tenants and issuing invites, by the method chosen in Q9.

**Every request** goes through, in order (architecture §6):
1. Tenant from host: unknown or suspended → 404.
2. Session: none → 401, or 302 on a page.
3. The session's tenant must equal the host's tenant, otherwise 401.
4. Role check, otherwise 403.

**Route matrix.** Built from today's routes (`mockup/server.ts`, `src/server.ts`). **Every new route is added here before it is merged.** A route not listed here is a review failure.

| Route | Public | member | admin | UST (Q9) | Notes |
|---|---|---|---|---|---|
| `GET /auth/sn/start`, `GET /auth/sn/callback` | ✓ | | | | To build. Rate-limited; callback checks `state` (and PKCE if F1) |
| `POST /auth/logout` | | ✓ | ✓ | | To build |
| Invite page, `POST` connection details | ✓ (valid invite only) | | | | To build. Rate-limited; the URL must match the recorded host; the secret goes to Secrets Manager |
| Activation (sign-in from the invite) | ✓ (valid invite only) | | | | To build. Requires `admin` or `nowops_admin`; spends the invite |
| Tenant creation, invite issue | | ✗ | ✗ | ✓ | To build. Holds no client token |
| `GET /api/health` | ✓ | | | | Public version returns `{ ok }` only. Today it also returns the model id and dependency detail, which goes behind a session or onto an internal port |
| `GET /api/me` | | ✓ | ✓ | | |
| `GET /api/dashboard`, `/api/series`, `/api/breakdown`, `/api/next`, `/api/list`, `/api/places`, `/api/services`, `/api/app`, `/api/graph` | | ✓ | ✓ | | Read as the user. 409 before the first scan |
| `GET /api/checks`, `/api/validate`, `/api/profile`, `/api/connection` | | ✗ | ✓ | | Settings, connection health (D-009). `/api/connection` never returns the secret |
| `POST /api/scan` | | ✗ | ✓ | | Runs with the admin's token (proposal, open in D-016) |
| Profile overrides, tile visibility, OAuth client secret update | | ✗ | ✓ | | To build (D-009) |
| `POST /api/chat` | | ✓ | ✓ | | Per-user rate limit; identity from the session |
| `GET /api/resolve/rules`, `/api/resolve/queue`, `/api/resolve/ticket/:number` | | ✓ | ✓ | | Queue is the signed-in user's |
| `POST /api/resolve/steps\|brief\|draft/:number` | | ✓ | ✓ | | Per-user rate limit. A cached draft is served only after the ticket is read as the user |
| `POST /api/resolve/write` | | ✓ | ✓ | | **On in release 1** (D-014). Whitelisted actions only; confirmation bound to the exact change; per-user rate limit; the `as` field is removed |
| `GET /api/resolve/people` | | ✗ | ✗ | | **Removed.** It feeds the "look at the queue as someone else" picker |
| `POST /api/skip-confirm` | | ✗ | ✗ | | **Removed.** No confirm step (D-008) |

**Object-level checks.**
- **Tenant:** every repository function takes `tenantId` first and filters by it. Composite foreign keys stop cross-tenant references (`docs/database.md` §2, §10). Every cache key starts with the tenant.
- **User:** chats are read and written only by their owner (`tenant_id, user_id`).
- **Client records:** the user's own token means ServiceNow's ACLs decide what they can read and change. Every in-memory cache of instance data is keyed by user as well as tenant (`docs/database.md` §5).
- **Test:** for each route, call with tenant B's ids from a tenant A session and expect 404 or 403. The isolation test in `docs/database.md` §10 covers the repository layer.

**Writes to the client instance (D-014).**
- Every action in the D-014 table is a fixed, whitelisted request body built by the server. Reference fields take sys_ids only; free text is length-capped. The model never chooses the table, path or method.
- **Confirm-before-commit:** the page shows the record, the table and each field with its new value, and the server sends only the change the user confirmed. The confirmation is bound to that exact body, for example with a short-lived token over a hash of it, so a replayed or altered request is refused.
- Writes run with the user's token; ServiceNow's own history records the person (§9).
- The `RESOLVE_WRITES` dry-run switch is for non-production use.
- **Known gap:** the mockup writes fixed state numbers. They must come from the scanned state classes before release (Q10, D-011).

---

## 4. Input validation and query safety

### 4.1 Requests
- zod schema on every body, query and param; unknown fields rejected; strings length-capped. Body limit 64 kB.
- Allow-lists for anything that becomes a table, field, order, definition id, ticket number or write action. Today's regexes in `mockup/server.ts` become zod schemas.
- SQL only through drizzle or parameterised queries. No string-built SQL.

### 4.2 ServiceNow queries composed by the model
The assistant's tool loop lets the model compose ServiceNow encoded queries from a user's question; that is the product (D-015). So instead of "never build a query from user input", every composed query passes all of these on the server before it is sent:

| Control | Code |
|---|---|
| Table on the allowlist **and** present in the tenant's scan | `src/tools/tables.ts` |
| Denied tables and fields never queried or returned | `src/tools/tables.ts` |
| Every field in the query exists (ServiceNow drops unknown fields and returns the whole table, D-005) | field-existence probe |
| Query shape check | `src/servicenow/stats.ts` |
| `sys_id`s only from this question's own lookups | `src/llm/agent.ts` |
| At most 25 rows per list; at most 6 tool calls per question | `src/tools/*`, `src/llm/agent.ts` |
| Runs with the signed-in user's token, so ServiceNow ACLs apply | ServiceNow client |
| A rejected query is declined, never re-tried with a variation | ServiceNow client |
| No tool writes | `src/tools/index.ts` |

A new tool, or a new way to reach the instance, comes with its row in this table.

### 4.3 File uploads
None in release 1. Adding one means writing this section first: size limit, type by content, random server-side name, malware scan, served as a download.

### 4.4 Outbound requests
- Egress is default-deny through the squid proxy. Allowed hosts: each tenant's instance, the UST gateway, and each client LLM endpoint in use. UST adds every host (D-016).
- `connections.instance_url` must match `^https://[^/]+$` (database CHECK). It is recorded by UST when the tenant is created, and the client's invite entry must equal it.
- A client LLM endpoint is used only once its host is allowlisted and its terms are agreed (Q4).
- Nothing the model writes is used as a URL, host, path or HTTP method.
- Outbound calls time out: ServiceNow 10 s (`src/servicenow/client.ts`); LLM endpoints `<TBD>`.
- If a client instance restricts inbound IP addresses, NowOps' fixed egress address is given to the client (Q19).

### 4.5 Output
- React escaping. No `dangerouslySetInnerHTML` for instance or model text. Model answers are plain text.
- Deep links to ServiceNow are built by the server from the tenant's `instance_url` and a validated table and query, never taken from model output.

### 4.6 Error handling
- One error middleware. Response format today `{ error: string }`; any change is Q20.
- Users never see stack traces, SQL, file paths, versions, ServiceNow error bodies, or whether an account exists.
- Full detail goes to the log with the request id, secrets redacted.
- A decline ("no definition matches", "not available on this instance") is a normal 200 with a reason, not an error.
- Production runs without verbose errors. Stub LLM mode is refused at boot in any deployed environment.

---

## 5. Secrets

**Store.** AWS Secrets Manager, read by the task's IAM role at start, and at onboarding for a tenant's client secret.

| Secret | Notes |
|---|---|
| Gateway key | Which key NowOps uses is Q3; the platform team rotates it; runtime-repointable |
| Per-tenant OAuth client secret | Referenced from `connections`; the client rotates it and their admin updates it in Settings (R2); deleted at offboarding |
| Per-tenant client LLM key | Referenced from `tenants`; deleted at offboarding |
| Session-encryption key | Rotating it signs everyone out |
| Credentials of the UST tenant-creation method | Depends on Q9 |
| Database role passwords | RDS rotation |

**Never in:** code, git history, the container image, a committed `.env` (only `.env.example` with placeholders), logs, error messages, the front-end bundle, the database (apart from the encrypted tokens in `sessions` and invite hashes).

**Controls.** gitleaks in CI (GitHub Actions) and as a pre-commit hook. pino `redact` deny-list for secret field names; `mask()` wherever a key has to appear. The built bundle is searched for key patterns in CI.

**Today.** The ServiceNow refresh token and client secret live in a local `.env`, renewed by hand. That ends when the OAuth sign-in and Secrets Manager are in place.

---

## 6. Transport and headers

- HTTPS only. TLS 1.2+ at the load balancer; HTTP redirects to HTTPS; HSTS (`max-age` ≥ 1 year, `includeSubDomains`). TLS to RDS required (`docs/database.md` §7).
- helmet, with:
  - **CSP:** `default-src 'self'; script-src 'self' 'nonce-…'; connect-src 'self'; img-src 'self' data:; font-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`. `form-action` also allows the tenant's instance for the sign-in redirect if needed. No `unsafe-inline` for scripts; `style-src 'unsafe-inline'` only if the chart library needs it. No font is loaded from anywhere: Aptos where installed, Arial fallback (`docs/design-system.md` §2.4).
  - `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: strict-origin-when-cross-origin`.
- **CORS:** none. The SPA is served from the same origin as the API, so no `Access-Control-Allow-Origin` header is ever sent.
- **CSRF:** `Origin` (or `Referer`) must equal the tenant's host on every POST, PUT, PATCH and DELETE, plus SameSite=Lax cookies. The OAuth callback is a GET protected by `state` (and PKCE if F1).
- Verify the headers with a test in CI, and once against the deployed host.

---

## 7. Abuse protection

| Layer | Control |
|---|---|
| Edge | AWS Shield Standard (automatic on the load balancer); AWS WAF with managed rule groups and a rate rule by IP (D-018). Value `<TBD>` (Q7); a client's staff may share one NAT address |
| Host | Unknown or suspended host → 404 before any session or database work |
| Auth and invite routes | WAF rule, plus an app limit per session on `/auth/sn/*` and the invite routes `<TBD>` (Q7) |
| Expensive and changing routes | Per-user rate limit on `/api/chat`, Resolve steps, brief and draft, and `/api/resolve/write` `<TBD>` (Q7) |
| Client instance | At most 6 concurrent queries per dashboard load (`mockup/server.ts`); per-user figure cache (architecture §7 flow 3) |
| Requests | 64 kB body limit; timeouts on every outbound call |
| Cost | Maximum task count; AWS budget alarm; LLM token cap per P-10 (on the UST gateway: per-tenant daily budget with fallback to rules) |

UST security sign-off for the public surface is a go-live gate (Q2).

---

## 8. AI / LLM

- **The model supplies arguments, never requests.** Every tool runs on the server through §4.2. All assistant tools are read-only (D-015); writes happen only on the Resolve page, confirmed by the user (§3).
- **Prompt injection.** Ticket text, journals and articles may contain instructions. The defence is structural: read-only tools, the user's own ACLs, allowlists and denied fields. An injection can at most make the assistant read what the same user could already ask for. It cannot write, because the assistant has no write tools.
- **Output validation.** Every number in an answer must appear in a cited tool result (one retry, then refusal). Article citations must map to returned articles. `sys_id`s only from this question's lookups.
- **What reaches the model** is listed per flow in architecture §7 (flows 4 and 5). Never secrets, never another tenant's data.
- **Personal data.** Denied fields keep structured identifiers out. Free text can still carry them, so masking on the path to the LLM is confirmed before the first client (Q15).
- **Provider (P-10).**
  - On the UST gateway: UST's model agreements and a per-tenant daily budget.
  - On a client's own LLM: data goes under the client's terms. The endpoint is enabled only after the interface, masking, region and retention are agreed (Q4). NowOps sets no token cap.
- **Logging.** Token usage, steps, latency and tool arguments; never answer text or result rows (§12).
- **Evaluation.** `tools/eval.ts` in CI; a fall in any score blocks the merge.

---

## 9. Accountability without an audit table

NowOps keeps **no audit table** (D-014).
- **Changes to client records** run with the user's own token, so ServiceNow's own history (`sys_audit`, journal, `sys_updated_by`) attributes them to the person.
- **NowOps admin changes** carry who and when on the row: `tenant_profile.overrides_updated_by` and `scanned_by`, `tenant_profile_history.changed_by`, `invites.used_by`, `definitions.created_by`.
- **UST tenant-creation actions and security events** (tenant created, invite issued or spent, secret changed, the events in §12) are operational log lines in CloudWatch. They are kept for the log retention in Q16 and are not tamper-evident.

Revisit if UST security or a client contract requires a tamper-evident record.

---

## 10. Database

Details in `docs/database.md`. The security points:
- Roles: `nowops_migrator` (DDL, migration task only); `nowops_app` (DML, insert-only on `definitions` and `tenant_profile_history`); master for break-glass only. No standing personal logins (§8).
- Role-level `statement_timeout`, `idle_in_transaction_session_timeout` and `lock_timeout` (§7).
- Encryption at rest with a customer-managed KMS key; TLS in transit; deletion protection in production (§9).
- Retention purges by `pg_cron`; user and tenant deletion as in §11. Deleted data remains in backups for the backup retention (Q16).

---

## 11. Dependencies and supply chain

- `package-lock.json` committed; `npm ci` in CI and image builds.
- `npm audit` and trivy (image and dependencies) in GitHub Actions; Dependabot on.
- **Patch window:** set by UST's vulnerability policy, or a client contract where stricter `<TBD>`.
- New dependency review: is it needed, is it maintained, what does it pull in. Prefer built-ins (`fetch`, `crypto`).
- Container: minimal base image, non-root user, compiled JS (no `tsx` in production).
- gitleaks in CI and as a pre-commit hook.

---

## 12. Logging and security monitoring

- pino JSON to CloudWatch with `reqId`, `tenantId`, `userId`. Never answer text, result rows, tokens or prohibited data (architecture §16).
- **Security events** (logged, with alarms where noted; thresholds `<TBD>`, Q17):
  - denied-table or denied-field attempts, and `sys_id`s not from this question's lookups (spike alarm per tenant);
  - CSRF rejections;
  - OAuth callbacks with a bad `state` or a refused code exchange (sign-in failure alarm per tenant);
  - session-tenant and host mismatches;
  - token-endpoint refusals for a tenant's OAuth client (alarm, R2);
  - invite misuse: unknown, expired or used tokens, URL mismatches, activation refused for a missing role;
  - writes refused for a missing or mismatched confirmation;
  - UST tenant-creation sign-ins and actions (each one alerted, recipient `<TBD>`);
  - per-tenant token budget near its limit (alarm).

---

## 13. Incident response

| Item | Value |
|---|---|
| Security contact and escalation | `<TBD>` |
| UST security team contact | `<TBD>` |
| Client notification: who, how fast | `<TBD: per client contract>` |

**Containment actions, ready before go-live:**
1. **Cut off one tenant:** set `tenants.status = 'suspended'`, then `DELETE FROM sessions WHERE sess->>'tenantId' = $1` (`docs/database.md` §11). Ask the client to rotate or disable the OAuth application if their tokens may be exposed.
2. **Cut off one user:** `DELETE FROM sessions WHERE sess->>'userId' = $1`; the client deactivates them in ServiceNow or their SSO.
3. **Suspected leak of session data:** rotate the session-encryption key (signs everyone out; stored tokens become unreadable).
4. **Gateway or client LLM key leaked:** the key owner rotates it; update Secrets Manager; redeploy.
5. **UST tenant-creation credentials compromised:** rotate them; review the log lines for tenant, invite or secret changes; revoke unspent invites.
6. **Preserve evidence:** CloudWatch logs by `reqId` and `tenantId`, before retention ages them out.

After each incident: a written timeline, the fix, and a row in §16 if the threat was not listed.

---

## 14. Penetration test before the first client

A go-live gate, because the app is internet-facing (D-018).
- **Scope:**
  - the internet surface (load balancer, WAF, host routing);
  - the OAuth sign-in flow; the invite and activation flow;
  - sessions and cookies;
  - tenant isolation across two test tenants;
  - the route matrix in §3, including the write route and its confirmation;
  - the assistant's query controls (§4.2) and prompt injection through ticket text.
- **Tester:** `<TBD: external firm or UST internal team>`.
- **Exit:** every critical and high finding fixed, or accepted in writing by `<TBD>`. Retest after fixes.
- Repeat `<TBD>`.

---

## 15. Vulnerability disclosure

- Serve `/.well-known/security.txt` (RFC 9116) on every tenant host, with `Contact: <TBD>`, `Expires`, and `Preferred-Languages: en`.
- The contact is monitored, and reports are acknowledged within `<TBD>`.

---

## 16. Threat model

| Threat | Entry point | Impact | Control | Tested by |
|---|---|---|---|---|
| Unauthenticated access | Any route not marked public | Client data leak | Session middleware | Test: 401 on every non-public route |
| Cross-tenant access | Host name, ids in URL or body | Client data leak | Tenant from host must equal the session's tenant; `tenant_id` on every query; composite FKs; tenant in cache keys | Isolation test (`docs/database.md` §10); route test with tenant B ids |
| Identity taken from the browser | `context.user`, picker, `as` field | User acts or reads as someone else | Identity only from the session; fields removed (§17) | Test: identity fields in a request are ignored |
| Member reaches admin routes | Settings and scan routes | Overrides or tiles changed | Role check | Test: 403 as member |
| Write without the user's intent | `/api/resolve/write` | A client record changed wrongly | Whitelisted actions; confirmation bound to the exact body; user's token | Test: unconfirmed, replayed and altered requests are refused |
| Wrong state written | Resolve write path | Ticket put in the wrong state on an instance with renumbered states | State values from the scan (Q10) | Test on an instance with custom states |
| OAuth code or `state` injection | `/auth/sn/callback` | Session bound to an attacker's account | `state` check, PKCE if F1, exact redirect URI | Test: bad `state` is rejected |
| Invite leaked or guessed | Invite link | An outsider connects a tenant | Random token, stored hashed, single use, 7 days; URL must match the recorded host; activation needs `admin` or `nowops_admin` on that instance | Test: reuse, expiry, wrong URL, missing role |
| Session theft | Cookie | User impersonated | `__Host-`, HttpOnly, Secure, SameSite, expiry, id regenerated at sign-in | Header test; pentest |
| Token theft from the database | `sessions` table, backups | Access to a client instance as users | AES-256-GCM with a key outside the database; short session life | Code review; pentest |
| UST tenant-creation account compromise | Its sign-in | Tenants or invites created or altered | Strong authentication with MFA, alert on every sign-in, no client token held (Q9) | Test: alarm fires |
| Model query returns the whole table | Assistant tools | Wrong figure; over-broad read | Field-existence probe, shape check, row cap | Unit tests; eval set |
| Prompt injection | Ticket text, journal, articles | Wrong answer; reading beyond the question | Read-only tools, user's ACLs, allowlists, grounding check | Eval set with injected text |
| Prohibited data reaches the model | Free text in tickets | Policy breach | Denied fields; masking (Q15); regulated tables excluded | Fixture with masked patterns |
| Data sent to a client's own LLM under unagreed terms | Tenant LLM settings | Policy or contract breach | Endpoint enabled only after Q4 terms; host allowlisted by UST | Review at enablement |
| Cached figure or draft shown to a user without access | Figure cache, `llm_output_cache` | Data leak across users | User in cache keys; draft served only after a read as the user | Test with two users of different access |
| SSRF through an instance or LLM URL | Invite form, tenant LLM settings | Requests to internal hosts | `https://host` CHECK; must equal the UST-recorded host; squid allowlist | Test: rejected URLs; proxy refuses an unlisted host |
| XSS through instance or model text | Rendered answers, ticket fields | Session misuse in the browser | React escaping, plain-text answers, strict CSP | Test with script payloads in fixtures |
| Leaked secret | Repo, image, logs, bundle | Full compromise | Secrets Manager, gitleaks, redaction, bundle scan | CI |
| LLM cost exhaustion | `/api/chat`, Resolve drafts | Budget overrun; gateway outage for others | Per-user rate limit; per-tenant budget per P-10 | Test: limit returns 429; budget fallback |
| Volumetric attack | Public load balancer | Outage; cost | Shield Standard, WAF rate rule, maximum task count, budget alarm | WAF config review; pentest |

---

## 17. Known gaps today

The mockup and current server are prototypes and meet almost none of the above. Each gap closes before the first client:

| Gap | Where | Closed by |
|---|---|---|
| No authentication on any route | `mockup/server.ts`, `src/server.ts` | §2, §3 |
| Identity from the browser: `context.user`, the "Working as…" picker, `/api/resolve/people`, `as` in `/api/resolve/write` | Mockup page and server | Removed; identity from the session |
| Chats default to a shared `conversationId` of `'default'` when the page sends none | `src/server.ts` | Chats keyed by tenant and user in Postgres |
| One shared service credential reads and writes for every user | `.env`, `src/config.ts`, `mockup/server.ts` | Per-user OAuth tokens (D-014) |
| Writes send fixed state numbers and have no confirmation binding | `mockup/server.ts` `/api/resolve/write` | Q10; §3 confirm-before-commit |
| Secrets on a laptop | `.env`, PowerShell scripts | Secrets Manager |
| `innerHTML`, inline handlers, Google Fonts, `localStorage` | `mockup/public/app-preview.html` | React rewrite (architecture §1) |
| `/api/health` exposes the model id and dependency detail | `src/server.ts` | Public `{ ok }` only |
| No security headers, CSRF check or rate limits | Both servers | §6, §7 |
