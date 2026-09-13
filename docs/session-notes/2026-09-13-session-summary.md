# Session summary — 2026-09-13

Context-compaction summary of the design session that produced the NowOps chatbot
spec (rev 5) and implementation plan. Copied verbatim from the session transcript
so the reasoning behind the decisions survives outside the conversation.

Source transcript:
`C:\Users\281489\.claude\projects\c--Users-281489-OneDrive---UST-Desktop-Ven-SN\03a249eb-2e56-401e-8ae1-3960fbac2fa6.jsonl`

---

## 1. Primary request and intent

The conversation moved through three phases:

**(a) ServiceNow connectivity.** Connect to `https://ven06951.service-now.com/`, then
additionally `https://abhrademo4.service-now.com/`, and use both simultaneously.
Explore their knowledge bases; survey "NowOps" on abhrademo4.

**(b) Chatbot planning.** Build a lightweight chatbot using the **Claude API (not the
Agent SDK)**, grounded in the abhrademo4 ServiceNow knowledge base, calling Claude
through the **UST LLM API Gateway**. The user was explicit: *"I want to plan
everything first for the chatbot before building anything."* It will later sit on the
NowOps dashboard page, and later still be absorbed into a **NowOps standalone app** (a
separate project/spec). Backend must follow the `nowstudio-reference.md` architecture.
The user added a specific requirement: **a visible source line under each answer**
showing which KB articles were used, linked by sys_id, or labelled when it fell back.

**(c) Aggressive simplification.** Mid-way the user reversed course: *"lets not build
the connector, seam"*, *"don't over engineer the code and keep the project simple"*,
*"I want you to delete most of the part from the Implementation and only keep which is
absolutely necessary"*, then *"Just delete everything from the code and lets build the
plan again and code later"*. They then approved adding query-rewriting + retry (D13),
asked to proceed without the gateway key, and asked twice whether the KB allowlist was
really required — leading to its measured removal.

**Standing constraint: no code is to be written until the user approves the plan.**

## 2. Key technical concepts

- ServiceNow OAuth 2.0 authorization-code grant; refresh-token grant; `state` parameter enforcement
- ServiceNow Zing text search via `sysparm_query=...^123TEXTQUERY321=<terms>`
- ServiceNow `sys_id` as guaranteed-unique primary key vs non-unique article `number`
- DPAPI encryption via `Export-Clixml` / SecureString (user + machine bound)
- UST LLM Gateway = LiteLLM proxy; standard Anthropic SDK with `baseURL` override; gateway renames model IDs (`claude-opus-4-8-Codon`)
- Azure Key Vault: secret **name** vs **version** vs **value** (the API key is the value)
- Retrieval evaluation: recall@k, threshold sweep, regression baselines, overfitting to an eval set
- Three-layer relevance gate: token guard → coverage floor → model decline
- Query rewriting / triage retry (D13); union-and-dedupe of result sets
- Citation verification via `[1]`–`[5]` labels mapped back to sys_id
- TypeScript ESM `NodeNext`, Express 5, zod, vitest, tsx
- superpowers skills: `brainstorming`, `writing-plans`, `systematic-debugging`, `subagent-driven-development`

## 3. Files and code sections

### `Desktop\Ven-SN\sn-oauth.ps1`

Multi-instance ServiceNow PowerShell client (~24KB). Registry at
`%USERPROFILE%\.servicenow\instances.json` (no secrets); per-instance DPAPI files
`<name>.cred.xml`, `<name>.oauth-client.xml`, `<name>.oauth-token.xml`. Functions:
`Register-SnInstance`, `Get-SnInstance`, `Use-SnInstance`, `Set-SnOAuthClient`,
`Connect-SnOAuth`, `Get-SnAccessToken`, `Invoke-SnApi`, `Test-SnConnection -All`,
`Get-SnDiagnostics`, `Invoke-SnRaw`, `Export-SnEnvFile`. Aliases `Invoke-SnOAuthApi` /
`Test-SnOAuth` kept for back-compat. Uses `TcpListener` (not `HttpListener`) for the
OAuth callback so no admin / URL-ACL is needed.

`Export-SnEnvFile` writes secrets without echoing:

```powershell
$wanted = [ordered]@{
    SN_INSTANCE_URL  = $inst.Url
    SN_CLIENT_ID     = $client.ClientId
    SN_CLIENT_SECRET = $client.ClientSecret
    SN_REFRESH_TOKEN = $refresh
}
# Preserve any existing non-SN_ lines (e.g. gateway settings added later).
Write-Host ("  SN_REFRESH_TOKEN {0} chars (not shown)" -f $refresh.Length)
```

### `docs/superpowers/specs/2026-09-13-nowops-chatbot-design.md`

629 lines, revision 5, 19 sections. Decisions D1–D13:

- D1 TypeScript + Express
- D2 live ServiceNow search
- D3 static HTML / vanilla JS
- D4 no fallback
- **D5 no KB filter (reversed rev 5)**
- D6 single-shot
- D7 no ingestion
- D8 `C:\dev\nowops-chat`
- **D9 withdrawn**
- D10 sys_id + `[n]` labels
- D11 three-layer gate
- **D12 no connector interface (reversed rev 4)**
- **D13 query rewrite + one retry**

### `docs/superpowers/plans/2026-09-13-nowops-chatbot.md`

2,062 lines, 7 tasks:

1. Scaffold, config, logging
2. ServiceNow OAuth + search
3. Relevance gate
4. Claude client / prompt / citations
5. Server, routes, boot
6. Chat UI
7. Eval + acceptance

The gate:

```ts
export function decide(query, articles, opts): GateResult {
  if (tokenise(query).length < opts.minTokens) {
    return { answer: false, reason: 'too_few_tokens', topCoverage: 0 }
  }
  const top = articles.reduce((best, a) => Math.max(best, coverage(query, `${a.title} ${a.body}`)), 0)
  if (top < opts.minCoverage) return { answer: false, reason: 'low_coverage', topCoverage: top }
  return { answer: true, reason: null, topCoverage: top }
}
```

The D13 retry branch in `src/server.ts`:

```ts
let gate = decide(message, articles, opts)
let retried = false
let rewritten: string | null = null

if (!gate.answer && cfg.retryEnabled) {
  rewritten = await llm.triage({ question: message, articles })
  if (rewritten === null) {
    return res.json({ answer: DECLINE_TEXT, sources: [], grounded: false,
                      gateReason: 'out_of_scope', retried: false })
  }
  retried = true
  const second = await sn.search(rewritten, cfg.searchLimit)
  const seen = new Set(articles.map((a) => a.id))
  articles = [...articles, ...second.filter((a) => !seen.has(a.id))].slice(0, cfg.searchLimit)
  gate = decide(rewritten, articles, opts)
}
```

Search query (post-allowlist-removal):

```ts
const sysparmQuery = [
  'workflow_state=published',
  `123TEXTQUERY321=${sanitiseQuery(query)}`,
].join('^')
```

Stub mode for building without the gateway key:

```ts
export function makeStubLlm() {
  return {
    async preflight() { log('llm.STUB_MODE', { warning: 'No real model. Answers are canned.' }) },
    async answer(opts) { /* returns `[STUB — no live model] ...` citing [1] */ },
    async triage() { return null },
  }
}
```

### `tests/fixtures/retrieval-eval.json`

35 in-scope + 10 out-of-scope questions. 15 in-scope are **verbatim incident text**
from abhrademo4 (`"windows security pop up everytime i try to use outlook."`,
`"Disable user account for frankie.morein"`); 20 are synthetic. Uses
`acceptableSysIds` arrays because duplicate articles exist. Out-of-scope uses real
queue noise (`"Hi Team,"`, `"nan"`, `"Bky OLO"`, monitoring alerts).

### `tools/set-gateway-env.ps1`

Prompts for the Key Vault secret **value** via `Read-Host -AsSecureString`, writes to
`.env`, strips trailing slash from the base URL, never echoes the key.

### `.env` (gitignored, 605 bytes)

`SN_*` OAuth credentials, `ANTHROPIC_API_KEY=placeholder-awaiting-keyvault-access`,
`ANTHROPIC_BASE_URL=https://llmproxy.ustdev.com`, `CLAUDE_MODEL=claude-opus-4-8-Codon`,
`LLM_MODE=stub`, `RETRY_ENABLED=true`, `GATE_MIN_TOKENS=2`, `GATE_MIN_COVERAGE=0.3`,
`SEARCH_LIMIT=5`, `PORT=3000`.

Memory file written:
`...\memory\servicenow-ven06951-connection.md` plus a `MEMORY.md` pointer.

## 4. Errors and fixes

- **`$args` collision in PowerShell** — renamed the splat hashtable to `$req`.
- **`switch ($status)` rebinds `$_`** so `$_.Exception.Message` was always empty. Fixed by capturing `$err = $_` before the switch.
- **PowerShell single-object trap (most consequential)**: a one-element result is a scalar whose `.Count` is `$null`, so `for ($i=0; $i -lt $res.Count; ...)` never ran and every one-result query scored MISS. This made the eval report 54% when the true figure was 80%. Fixed by `@()`-wrapping all search results; recorded in the plan's "Things that will bite you".
- **`if` used as an expression** without `$(...)` — parse error; rewrote with explicit variable assignment.
- **Committed a file I hadn't written or read**: `git add -A` swept in a 2,255-line implementation plan generated by another session. Disclosed plainly and flagged the plan as stale (it targeted the deleted BM25 design).
- **UTF-8 mojibake, introduced twice**: `Get-Content -Raw` read the spec as ANSI; `Set-Content -Encoding utf8` then wrote `â€"` for every em-dash (191 occurrences). Repaired both times via `[Encoding]::UTF8.GetString([Encoding]::GetEncoding(1252).GetBytes($t))` with a `?`-count guard, writing back with `New-Object System.Text.UTF8Encoding $false`.
- **Git here-string quoting failures** — `?`, quotes and parentheses in commit messages broke PowerShell parsing, causing git to treat message fragments as pathspecs. Fixed by writing messages to the scratchpad and using `git commit -F <file>`.
- **Overstated a diagnosis**: the script printed "If the body below is an HTML login page, the instance is redirecting API calls to SSO/MFA" unconditionally; the user quoted it back as evidence of MFA enforcement. Corrected — the measured evidence (`WWW-Authenticate: Basic realm="Service-now"` + JSON body) showed the opposite — and the script was rewritten to report evidence rather than assert causes.
- **Eval expectations were wrong twice**: `inc-14` (search returned a better Salesforce login SOP than the nominated article) and `inc-13`. Corrected `inc-14`, documented `inc-13`.
- **The allowlist justification was theory, not measurement.** It had been written into the spec as though measured. The user pressed twice; the A/B showed it changed one result. It was removed.

## 5. Problem solving

- Diagnosed basic-auth 401s on both instances with evidence rather than assumption; OAuth authorization-code succeeded on both.
- Established that KB article numbers are non-unique on **both** instances (ven06951 11%, abhrademo4 5%), proving it isn't a demo artifact and forcing sys_id keying (D10).
- Measured ServiceNow's Zing search at 74% recall@1 / 83% @5, eliminating the local BM25 index and sync subsystem.
- Measured that a single coverage threshold can't separate signal from noise (`"Hi Team,"` scores 1.00) → three-layer gate.
- Measured that query rewriting recovers 5 of 6 misses at rank 1 → ~89%, and that re-ranking is capped at 83% by recall@5.
- Measured that the KB allowlist changes exactly one result, invisible to users → removed.
- Unblocked the build from Azure Key Vault access via `LLM_MODE=stub`.

## 6. Security constraints in force

Org-level: never request, store, process, or display SSN, Aadhaar, PAN, Passport
numbers, Driver's License numbers, credit card numbers, or patient records.

Working practices established:

- Secrets live DPAPI-encrypted in `%USERPROFILE%\.servicenow\`, never in the OneDrive-synced folder.
- `.env` is gitignored and must never be committed.
- Secrets are never echoed to console or into the transcript.
- The user is never asked to paste a secret into chat.
- ven06951 is MemorialCare-branded healthcare, so queries stay on non-clinical tables and patient records are not retrieved.

## 7. Pending tasks

- Get the UST gateway API key (the **value** of Key Vault secret `codon-kvs` in `ustdev-az-is-ai-app-kv`) — user lacks Azure access; needs `Key Vault Secrets User` role or the value delivered securely. Then run `.\tools\set-gateway-env.ps1` and set `LLM_MODE=live`.
- Begin implementation — **only after the user approves**, and after they choose subagent-driven vs inline execution.

## 8. State at time of compaction

The knowledge-base allowlist removal was complete. A/B measurement over all 45 eval
questions:

```
WITHOUT allowlist    recall@1 26/35 (74%)   recall@5 29/35   noise rejected 7/10
WITH    allowlist    recall@1 27/35 (77%)   recall@5 29/35   noise rejected 7/10
Questions that changed:  syn-03   #2 → #1     (that's all of them)
```

Both documents edited: spec bumped to **revision 5**, D5 reversed to "No knowledge
base filter — search everything published" with the measurement recorded, D9 withdrawn
as a numbered placeholder, §8 query reduced to two clauses, §17 updated. The plan lost
`SN_KB_ALLOWLIST` from the zod schema, the `Config` interface, `parseConfig`,
`.env.example`, the search `buildPath`, and all test fixtures; the search test now
asserts `expect(url).not.toContain('kb_knowledge_base')` so a filter can't creep back
silently. `SN_KB_ALLOWLIST` was stripped from the live `.env` (1084 → 605 bytes).
UTF-8 mojibake reintroduced into the spec was repaired.

Verified: no remaining allowlist machinery in the plan, no placeholders, zero mojibake
in either document, plan 2,062 lines, spec 629 lines. Committed as `af0aab6`

> **Later correction.** The "1,682 / 478" figures reported at the time were wrong —
> `Measure-Object -Line` scores a blank line as zero lines, so those were non-blank
> counts, not line counts. The same pass also reported "zero mojibake" while two
> U+FFFD replacement characters sat in spec line 169: the check matched the
> `Ã`/`â€`/`Â` byte signature, which cannot catch U+FFFD because the original byte
> is already destroyed. Both were fixed in a later commit; encoding checks now test
> for U+FFFD as well.
"Remove the knowledge base allowlist after A/B measurement (rev 5)", working tree
clean.

Repo state: `.env`, `.gitignore`, `.claude/settings.local.json`,
`docs/superpowers/{specs,plans}/`, `tests/fixtures/retrieval-eval.json`,
`tools/set-gateway-env.ps1`. **No source code** — the user had it all deleted
(recoverable at `6286cd7`).

## 9. Next step

Confirm plan approval and execution mode (subagent-driven vs inline), then start
Task 1. The user's standing instruction is *"only after my approval we will start
building with new plan"* — so the next step is confirmation, **not** coding.

Worth noting when confirming: Tasks 1, 2, 3 and 6 need nothing from the user, and
Task 4 is the first that requires the live gateway key, which is why `LLM_MODE=stub`
was added.
