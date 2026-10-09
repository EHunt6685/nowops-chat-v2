# NowOps Standalone — Implementation Plan (Release 1)

**Status:** draft for review · **Date:** 2026-10-09
**Inputs:** `docs/architecture.md`, `docs/database.md`, `docs/security.md`, `docs/design-system.md`, `docs/decisions.md`, the mockup (`mockup/`) and the chatbot code (`src/`) at `bf26757`.
**Companion documents:** the five above. Where this plan and the decision log disagree, the log wins until the S-items below are recorded there.

This plan says **what** gets built, in what order, and how we know each part is done. It holds no code. Before each phase starts, we write a short task list for that phase alone.

---

## 1. Are we ready? Verdict

**Yes. No open decision blocks writing this plan or starting Phases 0–2.** Some of the open items do block particular later phases. Each one is listed in §3 with the phase it gates and the default we build to until it is answered.

What makes us ready:
- Scope, users, identity, hosting and stack are decided (D-014, D-018, owner answers of 2026-10-08).
- About half of the domain logic exists and has tests: the definitions engine, the tool loop and its guardrails, the ServiceNow client, the stats checks and the Resolve evidence.
- The schema, the route matrix, the request chain and the UI states are written down.

Where honesty matters:
- The mockup server (scan, dashboard routes, checks, the Resolve write path) has **no tests**. It is about 1,000 lines of logic that we have to port and test.
- Six ServiceNow facts (F1–F6) and the OAuth scope (Q11) are unverified. Sign-in cannot be built with confidence until Phase 0 checks them.

---

## 2. Decisions made in this session

These go into `docs/decisions.md` when you ask.

| # | Decision | Changes to docs |
|---|---|---|
| S1 | The web app keeps the mockup's layout: **Operational** and **Strategic**, with the mockup's sections. QBR, App360 and Backlog stay as tags on definitions | Architecture §1 and D-014 name three dashboards; D-009's "tile list waits on the split" is resolved |
| S2 | **Application 360, Software and CMDB plugin tiles are in release 1.** They are hidden automatically when the instance lacks the table (D-008) | D-005 "Open" and the D-014 build-order item 4 change |
| S3 | A client's own LLM can be **Anthropic-compatible or OpenAI-compatible** in release 1 | Architecture §7 flow 7; `tenants` gains a column for the interface type; one eval run per interface |
| S4 | **The scan runs with an admin's token**: at activation, and when an admin's request finds the profile stale. Members use the stored profile | Closes the D-016 "Open" item |
| S5 | **The UST platform team provides all AWS infrastructure** in NowStudio's shape. NowOps ships a container image, migrations and a list of what it needs (§6) | Architecture §3 boxes stop being [P] once the platform team confirms |
| S6 | **New repository.** Code we keep is copied in with its tests. This repo stays as the reference (mockup, research, docs) | Architecture §2 and §5 paths |
| S7 | **Builders:** you and Claude. Tasks are small and reviewable, with a check after each one | — |

Proposed defaults for build-team questions. Please confirm or change them:

| # | Proposal |
|---|---|
| Q20 | Errors stay `{ error }` and gain a `requestId` |
| Q21 | Release 1 accepts that figures can differ between tasks for up to the cache lifetime (3 min, D-003). We measure before adding a shared cache |
| Q10 | The scan also classifies request-item states and reads the incident hold-reason choices. Writes and definitions then use these values, never fixed numbers |

---

## 3. Open items and the phase each one gates

| Item | Needed by | Until answered we… |
|---|---|---|
| F1–F6, Q11 (ServiceNow facts, OAuth scope) | Phase 3 | Verify them in Phase 0. **This is the only item that could change the design**: for example, if users cannot read their own roles (F3), the role check needs another route |
| Q9 How UST creates tenants | Phase 4, production only | Use a command-line script in dev and test. Production stays gated |
| Q3 Gateway key, and a key for CI | Phase 6 | Use the current dev key locally |
| **Eval in CI** (new) | Phase 6 | GitHub-hosted runners cannot reach the gateway's private DNS or a client instance. We need a self-hosted runner, or eval runs outside CI. **Question for you and the platform team** |
| Q15 Personal-data masking on the path to the LLM | Phase 6 (go-live gate) | Build without masking; first client blocked. Proposal: a NowOps-side pattern mask as a baseline whatever the gateway does. **Needs your yes or no** |
| Q4 Data terms for a client's LLM | Enabling it for each tenant | Build both interfaces; keep them off for every tenant |
| P-8 Model-output cache | Phase 7 | Build Resolve without the cache. Add the table if P-8 is agreed |
| P-5 Automation accounts in people tiles | Phase 5 | Show them as the mockup does today |
| Q7 rate limits, Q8 session timeouts | Phase 3 / 6 | Values are configuration with conservative placeholders. Production gate |
| Q16 Retention | Phase 9 | Purge jobs are written with placeholder periods. Production gate |
| Q2 security sign-off, Q5 environments, Q6 domain, Q13 cost | Phase 9 | Request them in Phase 0 because they have the longest lead time |
| P-3, P-4, P-6, Q12, Q14, Q17, Q18, Q19 | Go-live or later | Not needed to build |

---

## 4. Gaps between the code and the docs

We fix each one in the phase shown and correct the docs to match.

| Gap | Fix | Phase |
|---|---|---|
| The tool loop's 6-step budget is not a hard cap: a batch of tool calls in one model turn can go past it. "Up to 7 model calls" is really 8–9 | Cap total tool calls at 6; correct the docs | 6 |
| No outbound proxy support. Node's `fetch` ignores the squid proxy | All outbound calls go through one proxy-aware fetch; proved in Phase 0 | 3 |
| Definitions are a TypeScript array (about 87 rows), not a table. Request-item rows hard-code states 3 and 4 | Seed the table from the array; placeholders replace the fixed states | 2, 5 |
| The scan, dashboard, checks and write routes are untested | Tests are written as they are ported | 5, 7 |
| `tools/eval.ts` needs live credentials, and its Resolve mode needs the mockup running | Point it at the new server; see "Eval in CI" in §3 | 6 |
| Settings sit in the profile menu as a stub; D-009 says a gear in the top bar | Follow D-009 | 8 |
| The mockup sends identity from the browser ("Working as…", `context.user`, `as`, `/api/resolve/people`) | Removed; identity comes from the session | 3, 7 |

---

## 5. Phases

Each phase ends with a working, tested slice. The server leads; each page follows once its routes exist. "Done when" is the exit check.

### Phase 0 — Verify and request (no product code)
- On the dev instance (abhrademo4), create an OAuth application with the authorization-code grant and a localhost callback. Then verify F1–F6 and the narrowest scope that allows the release-1 reads and writes (Q11).
- Confirm that the scan's metadata reads work with an `admin` token and with a `nowops_admin` token (F6), and how an ACL denial differs from a missing table (F5).
- Prove an outbound call through a squid-style proxy from Node 24.
- Check that the OpenAI-style tool calling the client-LLM adapter needs is available on a test endpoint.
- Send the requests in §6 to the platform team and UST security.
- **Done when:** a one-page findings note records each fact as true or false, the scope string is known, and the requests are sent. If a finding breaks the design, the docs are updated first.

### Phase 1 — New repo and carry-over
- Workspaces: `apps/server`, `apps/web`, `packages/shared` (architecture §5). Node 24, strict TypeScript, compiled build.
- Copy in the kept domain logic with its tests: definitions engine, tools, agent, ServiceNow client, stats, search, guard, Resolve evidence, logging.
- CI on GitHub Actions: type check, tests, gitleaks, `npm audit`, trivy.
- **Done when:** the carried-over tests pass (121 today) and CI is green on the first pull request.

### Phase 2 — Database
- PostgreSQL 16 locally (container). Schema and migrations exactly as in `docs/database.md`, including the CHECKs, composite keys, `definitions_current` view and role grants.
- Seed the definitions table from the existing array.
- The tenant-isolation test harness (two tenants, every repository function).
- **Done when:** migrations run on an empty database in CI and the isolation test passes.

### Phase 3 — Tenancy, sign-in and the request chain
- Tenant from host; unknown host → 404. Local dev uses `<tenant>.localhost`.
- ServiceNow OAuth sign-in and callback (`state`, plus PKCE if F1 holds), server-side sessions, tokens encrypted in the session, token refresh, sign-out, `/api/me`, role from ServiceNow roles.
- **A ServiceNow client built per request** from the tenant's instance and the user's token, through the proxy-aware fetch.
- The rest of the chain in architecture §6: request id, logger with redaction, helmet with a CSP nonce, body limit, CSRF origin check, zod validation, role check, error handler.
- **Done when:** two real users with different roles sign in to a dev tenant; every non-public route answers 401 without a session; a session used on another tenant's host is refused.

### Phase 4 — Onboarding
- A tenant-creation and invite script for dev and test (Q9 gates production).
- Invite page, connection-details form, reachability probe with its three messages, activation by an admin, spent invite.
- A secrets store: Secrets Manager in AWS, a local file in dev, behind one small module.
- First scan at activation (S4).
- **Done when:** a fresh tenant goes from script to activated dashboard on the dev instance, and the reuse, expiry, wrong-URL and missing-role cases are refused.

### Phase 5 — Scan, profile and dashboard API
- Port the scan out of the mockup into the definitions feature, per tenant. Persist the profile and its history (change notices). An admin's request re-scans a stale profile, with concurrent requests sharing one scan.
- The scan also classifies request-item states and hold reasons (Q10). Remove the fixed state numbers from the definitions.
- Figure cache keyed by tenant and user, with a lifetime and an entry cap. At most 6 concurrent queries per load.
- Routes: dashboard, series, breakdown, list, next, places, services, app, graph, checks, profile, validate, connection; 409 before the first scan.
- Tile states: available, hidden (D-008), unavailable, not readable with your access (F5), thin data.
- **Done when:** route tests pass against a fake ServiceNow, and on abhrademo4 and ven06951 the figures match the mockup's for the same period. Where they differ, the difference is explained.

### Phase 6 — Assistant API
- `/api/chat` builds the agent per request from the tenant's ServiceNow client and LLM client.
- LLM clients: UST gateway (Anthropic), client endpoint (Anthropic-compatible), client endpoint (OpenAI-compatible adapter, S3). Boot preflight for each configured endpoint; stub mode refused in deployed environments.
- Chats and messages in Postgres; the last 12 messages as context; chat list.
- Per-user rate limit; per-tenant daily token budget (`llm_usage`) for tenants on the UST gateway.
- Hard cap on tool calls (§4). Masking if Q15 is agreed.
- **Done when:** chat route tests pass; the eval scores on each interface are no worse than today's baseline; a user can only see their own chats.

### Phase 7 — Resolve API
- Queue, ticket, steps, brief and draft as the user; rule-based fallback, labelled.
- Writes: every D-014 action, with state values from the scan, run as the user. A confirmation token bound to a hash of the exact body: a replayed or altered request is refused. The dry-run switch works outside production. Cache entries are dropped after a write. The "via NowOps" suffix, `as` and `/people` are removed.
- **Done when:** each write action is exercised on the dev instance and shows the real user in ServiceNow history; the unconfirmed, replayed and altered cases are refused in tests.

### Phase 8 — Web app
In this order, each against the real API on the dev tenant:
1. **Foundations:** `tokens.css` from the design system mapped into Tailwind, shadcn components, the app shell (top bar, gear, theme, chat panel), routing with period and filters in the URL, a typed API client from `packages/shared`, and the shared state components (design system §4).
2. **Sign-in and onboarding screens:** invite, expired or used invite, activation refused, not set up yet, instance not answering.
3. **Operational dashboard**, then **Strategic** (including Application 360 and the plugin sections, S2). Tiles with provenance and "How is this counted?"; Recharts charts with a table view; drill-down to record lists.
4. **Assistant panel:** working, answered, couldn't answer, failed; source chips; announced to screen readers.
5. **Resolve:** queue, ticket detail, drafts, and the write confirmation dialog.
6. **Settings (D-009):** Connection (evidence, overrides, change notices, OAuth secret update), Tiles (visibility switches), Resolve (model off), Appearance. Needs two small server additions: overrides and tile visibility.
- **Done when (per screen):** the design-system definition of done holds (tokens only, every state built, keyboard pass, 1024/1280/1600 px, 200% zoom), and a build check fails on raw hex colours or `px` values outside `tokens.css`.

### Phase 9 — Hardening and go-live
- Every row of the security go-live checklist (`docs/security.md` §0); the route-matrix test; the header test against the deployed host.
- Retention jobs (`pg_cron`); `EXPLAIN` on every hot query against seeded data; a restore drill.
- Container image (non-root, compiled), migrations as a one-off task, deployed to the platform team's environments.
- `security.txt`, pentest, and UST security sign-off (Q2).
- **Done when:** the checklist is fully ticked, the pentest has no open critical or high finding, and the first client is onboarded on production.

**Dependencies:** 0 → 1 → 2 → 3 → 4 → 5 → (6, 7 in either order) → 9. Phase 8 step 1 can start after Phase 3; each later step of Phase 8 follows its server phase.

---

## 6. Needed from others (requested in Phase 0)

| From | What |
|---|---|
| UST platform team | ap-south-1 environments (Q5), ECS, RDS PostgreSQL 16 with `pg_cron`, Secrets Manager, WAF, the squid allowlist process, wildcard DNS and certificate (Q6), a CloudWatch log group, a fixed egress IP (Q19), a NowOps gateway key and model alias (Q3), CI access to the gateway (eval) |
| UST security | Public-surface sign-off (Q2), session timeouts (Q8), rate limits (Q7), masking (Q15), retention (Q16), client-LLM terms (Q4), pentest tester |
| Owner (you) | Q9, Q15 baseline-mask yes or no, the proposals in §2, retention values, the first client's name |
| Dev instance admin | An OAuth application on abhrademo4 (and ven06951 for the portability check) |

---

## 7. How we check the work

- **Every task:** unit tests with fakes and no network; type check; CI green before merge.
- **Every server phase:** a comparison on the two dev instances (abhrademo4, ven06951), so that nothing about one instance creeps back in (D-011).
- **Security tests that run in CI:** tenant isolation, the route matrix (401, 403, 404), confirmation replay, `state` tampering, identity fields ignored, XSS payloads in fixtures.
- **Assistant quality:** `tools/eval.ts` on fixed question sets for each LLM interface; a drop in any score blocks the merge.
- **UI:** the design-system definition of done for each screen.

## 8. Not in release 1

Jira or any second platform; a separate UST login and a cross-client view; per-client definition overrides (P-3); observability sources (P-6); chart snapshots (D-003); file uploads.
