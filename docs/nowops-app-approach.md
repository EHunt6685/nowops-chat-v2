# NowOps standalone app: proposed approach

**Status:** proposal for team review, not yet finalised · **Date:** 2026-09-15 · **Author:** Sachin Chavan, with Claude

NowOps today is a set of ServiceNow dashboards (Application 360, SDM QBR, Backlog Beacon) plus a proof-of-concept chatbot that answers knowledge and counting questions against one ServiceNow instance. The goal is to turn this into a standalone product a client connects to their own instance. ServiceNow is the first and only platform for now. Jira must be possible later without rebuilding. A client will connect one platform, never two.

This document describes the proposed shape of that product. It is written for review. Please challenge it.

A clickable mockup is at `docs/nowops-app-mockup.html`. The KPI research behind it is in `docs/2026-09-13-nowops-kpi-inventory.md` and `docs/2026-09-14-nowops-kpi-data-pull.md`.

---

## 1. The problem we are solving

Three findings from the research shape everything below.

1. **Most of Application 360 is ServiceNow-only.** CMDB, software licences, security incidents, vulnerabilities, application portfolio and server warranty have no Jira equivalent. Only the SDM QBR content (ticket volume, SLA adherence, MTTR, backlog and aging) exists on every service desk platform.
2. **Definitions, not access, are the hard part.** The demo instance holds 963 stored reports. Tiles with near-identical names use different filters. Several house definitions are wrong (the backlog tile counts an unfiltered 1,292 because it names a field that does not exist; "Closed within SLA" reads 0 because of a stray text match). The product must own its KPI definitions rather than read them from the client.
3. **Jira cannot be aggregated live.** Jira Cloud has removed exact totals from search, has no average or sum endpoints, and exposes SLA data only per request. Any design that computes dashboards by querying the instance on page load cannot work for Jira. This forces us to hold a copy of ticket data ourselves.

---

## 2. The approach in one picture

```
                 ┌──────────────────────────────────────────────────────────┐
                 │                       NowOps app                         │
                 │                                                          │
   Client's      │  ┌───────────┐  sync   ┌────────────┐  SQL  ┌─────────┐  │
   ServiceNow ───┼─▶│ Connector │────────▶│ NowOps     │──────▶│ Core    │  │
   instance      │  │ (one per  │         │ store      │       │ dashbd  │  │
                 │  │ platform) │         │ (Postgres) │──┐    └─────────┘  │
                 │  └─────┬─────┘         └────────────┘  │    ┌─────────┐  │
                 │        │ native query, live             └───▶│ Chatbot │  │
                 │        └────────────────────────────────────▶│         │  │
                 │        │                                     └─────────┘  │
                 │        └──────────────────────────▶ ┌────────────────┐    │
                 │                                     │ ServiceNow pack│    │
                 │                                     │ (live tiles)   │    │
                 │                                     └────────────────┘    │
                 └──────────────────────────────────────────────────────────┘
```

Two data paths, one rule.

- **Core path.** The connector copies tickets, SLA records and knowledge articles from the client's instance into our own database every fifteen minutes, translated into our own column names. The core dashboard, saved KPIs and the chatbot's counting answers read only from this database. Nothing on this path knows which platform the data came from.
- **Pack path.** Content that exists on only one platform (CMDB, licences, security) stays on the instance and is read live at page load with a native query, exactly as the chatbot proof of concept does today. A pack is shown only when its platform is the one connected.
- **The rule.** If a tile or answer can be produced from the store, it must be. Native queries are only for content the store deliberately does not hold. This is what keeps the core platform-agnostic.

---

## 3. The pieces

### 3.1 Connector

The only code that knows a platform. One folder per platform, implementing five functions:

| Function | What it does |
|---|---|
| connect / health | OAuth to the instance, confirm reachability |
| sync changed records | Pull tickets, SLA records and knowledge changed since the last cursor, translate, upsert into the store |
| search knowledge | Full-text search for the chatbot's how-to answers |
| run native query | Execute a validated platform query for pack tiles and chatbot fallback |
| prompt fragment | The platform vocabulary the chatbot needs when it writes a native query |

The ServiceNow connector reuses the existing OAuth client, knowledge search and stats executor from the chatbot proof of concept. Roughly two thirds of it is already written. A future Jira connector is a second folder implementing the same five functions, plus Confluence for knowledge since Jira has no knowledge base of its own.

### 3.2 The store and its schema

A PostgreSQL database holding a continuously refreshed copy of the client's ticket data, in our own shape. Five tables.

| Table | Holds |
|---|---|
| tickets | One row per incident, request, change or problem |
| sla_records | One row per SLA attached to a ticket |
| knowledge | Title, body, link for each published article |
| kpi_definitions | The standard KPI set we ship plus any a client adds |
| sync_state | Where the last sync stopped |

A ticket row has roughly twelve fields, all in our words. The translation from platform terms happens once, in the connector.

| Our field | ServiceNow source | Jira source (later) |
|---|---|---|
| type | table name | issue type category |
| status_bucket: open, in_progress, done | state code | built-in status category |
| fine_status: on hold, cancelled, resolved | state code | resolution name, best effort |
| priority_tier 1 to 5 | priority | rank in priority list |
| group | assignment_group | component or team |
| assignee | assigned_to | assignee |
| opened_at, resolved_at, closed_at | opened_at, resolved_at, closed_at | created, resolutiondate |
| reopened | reopened_time | changelog transition |
| native_id, native_url | sys_id, record link | issue key, browse link |

Every row also carries a connection id. Cheap now, avoids a migration if we go multi-tenant later.

**Why a store at all when the data is on the instance.** Trend charts become one SQL query instead of dozens of date-bucketed aggregate calls per page load. The dashboard keeps working when the instance is down. History survives even if the client archives records. The client's rate limits are never hit during a board meeting. And the same dashboard code works for Jira later, where live aggregation is impossible. The store is never edited by hand; deleting it and re-syncing rebuilds it.

### 3.3 Sync engine

One scheduled job per connection. It asks the connector for records changed since the last cursor, translates them, upserts them. ServiceNow supports this with keyset pagination ordered on `sys_updated_on`. A nightly reconcile compares identifier lists to catch deletions, which are rare on both platforms. Every tile shows a "last synced" stamp.

### 3.4 KPI definitions as data

A KPI is a stored record, not code: a table in our schema, a filter over our fields, an aggregate, an optional grouping, an optional time window. We ship the standard set. A client can add their own through the UI in the same shape. Because every definition is written against our schema, it works unchanged on any connected platform.

Standard set at launch: total, open, closed, cancelled tickets; by state, priority, group; aging buckets; oldest open per priority; opening versus closure per month; backlog management index; MTTR per priority per month; SLA adherence overall and per priority with trend; breach counts; approaching breach.

That is the entire SDM QBR dashboard, computed from two tables.

### 3.5 Core dashboard

The pages every client sees: Overview, SLA adherence, MTTR, Backlog and aging, My KPIs. The overview shows headline numbers. Each page shows the full breakdown, trend and a drill-through list with links back to the source record. All of it reads the store. Every tile shows its definition in our words and its sync time.

### 3.6 ServiceNow pack and native queries

A **native query** is a question in the platform's own language, sent to the live instance. For ServiceNow that is an encoded query such as `active=true^priority=1`. The chatbot proof of concept already composes, validates and runs these, including a guard against ServiceNow's habit of silently dropping clauses with unknown field names and returning the whole table.

The **ServiceNow pack** is the Application 360 content that is not about tickets: CMDB counts and health, servers and databases per application, licence entitlements, security incidents by age, priority and group, vulnerable items, server warranty expiry. These tiles are stored definitions too, each carrying a native query and a platform tag. They render live with the filter shown beside the number. Where the house definitions were found to be wrong in the research, the pack corrects them.

A ServiceNow client sees the core and the pack as one dashboard. A Jira client would see the core only, with a short note explaining why Application 360 is absent.

### 3.7 Chatbot

The proof-of-concept pipeline is kept: cheap pre-filter, one model call, one rewrite at most, citation verification, decline over guess, stub mode, eval harness. Two changes:

- Counting questions target the store. "How many open P1s" becomes a query on our schema, the same for every platform, validated against a schema we control.
- Pack questions fall back to a native query through the connector, with the existing validation. Questions about data no pack provides are declined.

Knowledge questions search the synced articles. The system prompt splits into a neutral core describing our schema and a platform fragment supplied by the connector.

A later refinement, not in the first build: replace the current verb-parsing protocol with proper model tool use, then expose the same tools over MCP so clients can ask NowOps from Claude, Copilot or Slack. That would be a product feature and it is agnostic for free because the tools speak our schema.

### 3.8 Admin and connection

An admin connects one instance during setup. The app records the platform, runs the first sync, and from then on shows the right pages. Clients never see a platform choice. One deployment per client, matching UST's existing Fargate and RDS pattern, with the LLM reached through the corporate gateway.

---

## 4. Two requests, end to end

**"Open P1 incidents" tile.** Core. One SQL query on the tickets table: count where type is incident, status bucket is open, priority tier is 1. Same code for every platform. Shows 14, with "synced 4 min ago".

**"Orphaned CIs" tile.** Pack. Sends a native query to the ServiceNow CMDB health table at page load. Shows the live number with the encoded query beside it and a link to the record list. Does not exist for a non-ServiceNow client.

The chatbot follows the same split. "How many open P1s do we have" is answered from the store. "How many CIs were updated last month" is answered by a native query for a ServiceNow client and declined for anyone else.

---

## 5. What we build now, and what we deliberately do not

**Now, ServiceNow only, in this order:**

| Phase | Work | Rough effort |
|---|---|---|
| 1 | Schema, sync engine, ServiceNow connector | 3 to 4 weeks |
| 2 | Standard KPI set and core dashboard | 3 to 4 weeks |
| 3 | ServiceNow pack from corrected Application 360 tiles | 2 weeks |
| 4 | Chatbot moved onto the store with native fallback | 2 weeks |

Estimates assume one developer familiar with the proof-of-concept code. Most of the time is in definitions and golden tests, not plumbing.

**Not now:** no Jira connector, no Confluence, no JQL, no platform-switching UI, no multi-tenant work, no MCP. None of it is touched until a Jira client exists.

**Later, when a Jira client arrives:** one new connector folder, the Jira half of the prompt, Jira eval fixtures, one config value in that client's deployment. About three to four weeks. Nothing already shipped to ServiceNow clients changes; the pack hides itself.

---

## 6. Four rules that keep Jira possible at near-zero cost

1. The tickets table uses our words, never ServiceNow's. If dashboard SQL contains a ServiceNow field name, that is a review failure.
2. The connector is one folder behind a five-function contract. Nothing outside it calls ServiceNow.
3. Every tile is tagged core or pack. Pack tiles carry a platform name and show only when that platform is connected.
4. The chatbot prompt is two strings, neutral core plus platform fragment, joined at boot.

---

## 7. Alternatives considered and set aside

- **One product per platform.** Fastest to a first Jira client, then two codebases forever.
- **Live query only, no store.** What the proof of concept does. Right for a proof, impossible for Jira, no history, every page load hits the client.
- **Buy a unified ticketing API (Merge, Unified.to).** Their model covers tickets and assignees, not CMDB, licences, SLA records or security incidents. Priced per connected client. A third-party host for client data under UST's egress and security posture. We would still build the schema and KPIs on top.
- **Store only, no pack.** Forces us to drop the two thirds of Application 360 that has no cross-platform meaning.
- **Use a third-party ServiceNow MCP server in the product.** Useful as a development tool for exploring instances. Not a product dependency: licence restrictions, supply chain, five hundred tools where we need five, and nothing gained for Jira.

---

## 8. Risks and open questions for the team

- **Translation quality is the product.** "Open" meant three different things on one demo instance. The connector's mapping needs golden tests and the definition must be visible beside every number.
- **Two paths need discipline.** The temptation will be to put a core KPI on the native path because it is quicker. Review has to hold the line.
- **We hold client ticket data.** Retention, encryption and per-client isolation need a policy decision. The mechanics fit UST's existing Postgres and Secrets Manager posture.
- **Freshness.** Is fifteen-minute sync with a visible stamp acceptable to the people who will look at this dashboard? Live counts remain available through the chatbot's native fallback.
- **Coarse status.** The core is built on a three-way status bucket because that is what every platform guarantees. On hold and cancelled are enrichments. Is that acceptable for the QBR views?
- **Jira first impression.** A Jira client sees the core and no Application 360. Correct, and a smaller demo. Sales should know before the first Jira conversation.
- **Effort.** The estimates above are one developer's rough view. They need a second opinion.

**What we are asking for:** does the split into a stored core and a live pack make sense to you, are the four rules in section 6 enough, and what have we missed?
