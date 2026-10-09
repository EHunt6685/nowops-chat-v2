# NowOps Design System

> **Purpose:** one source of truth for how NowOps looks and behaves, so every screen the AI builds is consistent, on-brand, and usable by real people with real ServiceNow data — not just pretty in a screenshot.
>
> **Rule for AI:** never invent a colour, font, font size, spacing value or component. Use a token from `tokens.css` or a component listed here. If one is missing, propose it in this file first.
>
> **Source of truth:** values will live in `apps/web/src/tokens/tokens.css`, created when the React app is scaffolded (architecture §5) and mapped into Tailwind. This file names each token and says when to use it. If the two disagree, `tokens.css` wins and this file gets fixed.

**Status:** draft · **Date:** 2026-10-08 · **Brand:** UST brand standards, applied strictly (palette and type). Any deviation needs approval from UST Communications.

---

## 1. Principles

1. **Clarity over decoration.** Every element earns its place. Clean, minimal, structured, per UST layout principles.
2. **Honest numbers.** Loading, empty, stale, unavailable, error and no-permission are distinct and designed. Never show `0` when the real answer is "unknown". Every number says when it was true and how it was counted.
3. **At most one primary action per screen.** Most dashboard screens have none, and that is fine.
4. **Accessible by default.** WCAG 2.2 AA.
5. **Desktop first, but never broken.** Designed for laptop and desktop; narrower widths collapse to one column (this is also what 200% zoom needs).

---

## 2. Tokens

Light theme first; a dark theme is kept (D-009, Appearance). The UST palette has no dark surface ramp, and brand rules allow white text only on Dark Teal, Dark Gray or Petrol. So the dark theme is built on Petrol, and its tokens are proposed in this file and approved before any screen uses them.

### 2.1 Brand palette (the only colours allowed)

| Brand name | Hex | Token(s) that use it |
|---|---|---|
| Dark Teal | `#006E74` | `--brand`, `--s1`, `--seq-3` |
| Light Teal | `#0097AC` | `--brand-2`, `--focus`, `--info`, `--s3`, `--seq-2` |
| Soft Black | `#231F20` | `--ink` |
| White | `#FFFFFF` | `--surface`, `--on-deep` |
| Purple | `#881E87` | `--s2` |
| Green | `#01B27C` | `--good` |
| Petrol | `#003C51` | `--deep`, `--seq-4` |
| Dark Gray | `#7A7480` | `--muted`, `--line-2`, `--axis`, `--s4` |
| Orange | `#FC6A59` | `--crit` |
| Dark Sand | `#DBD3BD` | `--warn` |
| Light Gray Wash | `#F2F7F8` | `--ground`, `--surface-2` |
| Mid Gray Wash | `#D7E0E3` | `--line`, `--grid`, `--seq-1`, `--selected` |
| Sand | `#ECECE1` | not used yet |
| Dark Gray Wash | `#C2BCBE` | `--mark-quiet` |

### 2.2 Semantic colour tokens

| Token | Value | Use |
|---|---|---|
| `--ground` | Light Gray Wash | page background |
| `--surface` | White | cards, panels, tables, chat messages |
| `--surface-2` | Light Gray Wash | zebra rows, hover on rows |
| `--selected` | Mid Gray Wash | selected row / nav item (always paired with a Dark Teal marker) |
| `--ink` | Soft Black | all body text; text on every status fill |
| `--muted` | Dark Gray | secondary text — **on `--surface` (White) only** (4.53:1; fails on Light Gray Wash) |
| `--line` | Mid Gray Wash | dividers, card borders (decorative) |
| `--line-2` | Dark Gray | input and control borders (needs 3:1) |
| `--brand` | Dark Teal | primary buttons, links, headings, table header rows, eyebrows |
| `--brand-2` | Light Teal | secondary accents, large text (≥ 24 px, or ≥ 19 px bold) only |
| `--deep` | Petrol | app header, hero bands |
| `--on-deep` | White | text and icons on `--deep` and `--brand` |
| `--focus` | Light Teal | focus ring on light surfaces (White on `--deep`/`--brand`) |
| `--good` | Green | success, SLA met — fill only |
| `--warn` | Dark Sand | warning, at risk — fill only |
| `--crit` | Orange | critical, breached, P1, errors — fill only |
| `--info` | Light Teal | informational banners — fill only |

**Status rule.** Green, Orange and Dark Sand are never used as text or as a bare icon on white (they fail 3:1). Status is always shown as a **fill with Soft Black text plus an icon and a word** ("✓ Met", "! Breached", "⚠ At risk"). The brand has no amber; Dark Sand plus the icon and label carries "warning".

**Measured contrast (for reference):**

| Pair | Ratio | Allowed for |
|---|---|---|
| Soft Black on White / Light Gray Wash | 16.3 / 15.1 | everything |
| Dark Teal on White / Light Gray Wash | 6.0 / 5.6 | text, links, buttons |
| White on Dark Teal / Petrol | 6.0 / 11.9 | button labels, header text |
| Dark Gray on White | 4.53 | secondary text, input borders |
| Dark Gray on Light Gray Wash | 4.19 | **not text** |
| Light Teal on White | 3.49 | focus ring, large text, chart marks — **not body text** |
| Soft Black on Green / Orange / Dark Sand / Light Teal | 5.9 / 5.7 / 10.9 / 4.7 | status pills and banners |
| Green / Orange on White | 2.7 / 2.9 | **never as text or icon** |

### 2.3 Chart tokens

| Token | Value | Use |
|---|---|---|
| `--s1` … `--s4` | Dark Teal, Purple, Light Teal, Dark Gray | categorical series, in this order (Dark Teal leads, per brand) |
| `--mark-quiet` | Dark Gray Wash | "Other", comparison period, de-emphasised marks |
| `--seq-1` … `--seq-4` | Mid Gray Wash → Light Teal → Dark Teal → Petrol | ordered scales (heatmaps, aging buckets) |
| `--grid` | Mid Gray Wash | gridlines |
| `--axis` | Dark Gray | axis lines and tick labels |

- Maximum four categorical series. More than four → top three plus "Other" in `--mark-quiet`.
- Green and Orange are reserved for status. They appear in charts only when they mean good/bad (e.g. met vs breached), never as a fifth series colour.
- Every chart has direct labels or a legend **and** a text summary or data table (see §7).

### 2.4 Typography

Brand rule: Aptos only, Arial fallback. No other sans-serif. Aptos is not self-hosted (Microsoft licence); it is used when installed locally (Windows with Microsoft 365), otherwise Arial.

| Token | Value |
|---|---|
| `--sans` | `Aptos, Arial, sans-serif` |
| `--display` | `"Aptos Light", Aptos, Arial, sans-serif` at weight 300 — headings ≥ 20 px only |
| `--mono` | `"Aptos Mono", Consolas, monospace` — query text, record numbers in code context |

| Token | Size / line height | Weight | Use |
|---|---|---|---|
| `--text-xs` | 12 / 16 | 400 | captions, axis ticks, timestamps |
| `--text-sm` | 14 / 20 | 400 | table cells, secondary text, controls |
| `--text-md` | 16 / 24 | 400 | body, chat messages |
| `--text-lg` | 20 / 28 | 300 (display) | section and card titles |
| `--text-xl` | 28 / 36 | 300 (display) | page titles |
| `--text-kpi` | 36 / 44 | 300 (display) | the number on a KPI tile |

- Eyebrows: `--text-xs`, all caps, bold, `--brand` (Dark Teal). The brand's Light Teal eyebrow fails contrast at this size on screen.
- Numbers in tables, KPI tiles and charts use `font-variant-numeric: tabular-nums`.
- Headings Dark Teal or Soft Black; body Soft Black.
- Body line length 45–75 characters (chat messages, help text).

### 2.5 Spacing, radius, elevation, motion

- **Spacing:** `--sp-1` 4, `--sp-2` 8, `--sp-3` 12, `--sp-4` 16, `--sp-5` 24, `--sp-6` 32, `--sp-7` 48, `--sp-8` 64 px — nothing else.
- **Radius:** `--r-s` 8 px (controls, pills), `--r-m` 14 px (cards), `--r-l` 22 px (modals, chat panel).
- **Elevation:** two levels. `--shadow-1` cards at rest; `--shadow-2` modals, popovers. Shadows are tinted Soft Black, never coloured. Prefer a `--line` border over a shadow.
- **Motion:** `--dur` 200 ms with `--ease`. Animate opacity and transform only. Honour `prefers-reduced-motion` (no movement; fades only). No count-up animations on KPI numbers.

### 2.6 Layout and breakpoints

| Name | Min width | Layout |
|---|---|---|
| narrow | 0 | single column, 16 px gutter; not designed for, but must not break (also covers 200% zoom) |
| laptop | 1024 | minimum designed width; 2-column tile grid, chat as side panel or own page |
| desktop | 1280 | **reference design width**; 3–4 column tile grid, 24 px gutter |
| wide | 1600 | content max-width 1440, centred; no further stretching |

- No horizontal page scroll at any width. Wide tables scroll inside their own container.
- Header: product name left, UST logo right (approved asset, unmodified, clear space three times the "U" anchor).

---

## 3. Components

For each: purpose, variants, required states. Accessibility notes in §7.

| Component | Variants | Required states |
|---|---|---|
| Button | primary (Dark Teal fill, White text), secondary (White, Dark Gray border), ghost, danger (Orange fill, Soft Black text) | default, hover, focus, active, disabled, loading |
| Input / select / textarea | text, search, select | default, focus, filled, invalid (message below field), disabled |
| Filter bar | period control, assignment-group picker, reset | applied filters always visible as chips; filters live in the URL |
| KPI tile | value, value + change vs previous period, value + target | loading, value, no data yet, cached, unavailable, not readable with your access, error; read time; "How is this counted?" link |
| Status pill | priority (P1–P4), SLA (met / at risk / breached) | fill + Soft Black text + icon + word |
| Table / record list | sortable, paginated | loading skeleton, empty, error, paginated, sorted; record number links to ServiceNow in a new tab |
| Chart | line, bar, stacked bar, donut (≤ 4 slices) | loading, empty, error; legend or direct labels; text summary |
| Drill-down | tile → record list | carries the tile's filters; breadcrumb back to the dashboard |
| Chat message | user, assistant, system notice | working, complete, failed |
| Chat tool indicator | "Looking up…" with the step name | running, done, failed |
| Answer source | chip under an assistant answer | shows what the answer was computed from: table, filter, when it was read, link to the records in ServiceNow |
| Chat composer | — | empty, typing, sending (disabled), error |
| Modal / confirm dialog | — | focus trap, Esc closes, returns focus to trigger |
| Write confirmation | one per Resolve action (D-014) | review (record number, table, each field with its new value), sending, done, failed, dry run (says nothing was written) |
| Banner / toast | info, success, warning, error | auto-dismiss only for success and info |
| Tooltip | — | on hover **and** focus; never the only place information lives |
| Navigation | top tabs / side nav | current page indicated (Dark Teal marker + `aria-current`), keyboard reachable |

**Domain mappings (define once, use everywhere):**

| Value | Pill |
|---|---|
| P1 Critical | Orange fill |
| P2 High | Dark Sand fill |
| P3 Moderate | Mid Gray Wash fill |
| P4 Low | White fill, Dark Gray border |
| SLA met | Green fill, "✓ Met" |
| SLA at risk | Dark Sand fill, "⚠ At risk" |
| SLA breached | Orange fill, "! Breached" |
| KPI change, good direction | Green fill chip, arrow + "+4.2%" |
| KPI change, bad direction | Orange fill chip, arrow + "−3.1%" |
| KPI change, neutral metric | no fill, Soft Black arrow + value |

---

## 4. States (must exist for every data view)

| State | What the user sees | Example copy |
|---|---|---|
| Loading | skeleton matching the final layout (no spinner-only pages) | — |
| Empty (no data yet) | explanation | "Nothing is recorded for this on your instance yet." |
| Empty (filtered) | which filter caused it + how to clear | "No incidents for Network Ops in the last 30 days. Clear the group filter." |
| Cached | the figure, with the time it was read from the instance | "Read 2 min ago. Reload to read again." |
| Unavailable | the instance did not answer; **no figure is shown** (D-013) | "Your ServiceNow instance isn't answering. Figures appear when it does." |
| Error | what happened + retry | "Something went wrong loading this. Try again." |
| No permission | why + who to ask; distinct from "not installed" | "You need read access to Incident (itil role). Ask your ServiceNow admin." |
| Partial | what loaded, what didn't | "Showing 6 of 8 tiles. CMDB tiles couldn't load — try again." |
| Hidden | the instance lacks the table, or nothing is recorded for the definition (D-008) | not shown on the dashboard; listed on Connection health and the Tiles page |

**Every number carries its provenance:** the time it was read from the instance, the query that produced it, and a link to the records it counted (D-004, D-013). Every KPI has a "How is this counted?" disclosure giving the definition in plain words.

**Chat states:**

| State | What the user sees |
|---|---|
| Working | tool indicator naming the step ("Counting open P1 incidents…"); composer disabled until the answer arrives |
| Answered | the whole answer appears at once, after its numbers are checked (D-015), with its source chip |
| Couldn't answer | says so plainly, says why, suggests a rephrase or the relevant dashboard |
| Out of scope | "I can only answer questions about your ServiceNow data." |
| Failed | "That didn't go through. Try again." with retry; the user's message is kept |

---

## 5. Interaction rules

- The assistant is read-only (D-015). Every Resolve write (D-014) goes through the write confirmation: it names the record ("Resolve INC0012345?"), shows each field with its new value, and sends nothing before Confirm. Cancel leaves the record untouched.
- Forms validate on blur and on submit; errors appear next to the field and in a summary at the top.
- Disable submit while sending; prevent double-submit.
- Every page is linkable: period, filters, and selected tab live in the URL, so a QBR view can be shared as a link. The back button works.
- Long lists paginate (50 per page default); never render 10,000 rows.
- Links to ServiceNow records open in a new tab and say so (icon + `aria-label` "opens in ServiceNow").

---

### Screens outside the dashboard

| Screen | Who sees it | What it shows |
|---|---|---|
| Invite | The client's ServiceNow admin, from the invite link (D-016) | Instance URL, OAuth client id and secret; what NowOps will read and write; continue to sign-in |
| Invite expired or used | Anyone opening a spent or expired link | Says which, and to ask UST for a new invite |
| Activation refused | A user without `admin` or `nowops_admin` | Says the role is needed; the invite stays usable until it expires |
| Not set up yet | A member signing in before activation | "Your ServiceNow admin hasn't finished setting up NowOps yet." |
| Instance not answering | Anyone, when sign-in or the first read fails | Says the instance didn't answer; no figures |

## 6. Content and copy

- Voice: nimble, confident, tenacious (UST). In practice: short, direct, specific.
- Plain language, sentence case. Eyebrows are the only all-caps text.
- Use the user's words: "incident", "assignment group", "SLA" — not internal field names (`assignment_group`, `sys_id`).
- Errors say what happened and what to do — never a raw stack trace or error code alone.

**Numbers and dates:**

| Kind | Format | Example |
|---|---|---|
| Counts | locale thousands separator | 1,292 |
| Percent | one decimal place | 92.4% |
| Duration | largest two units | 45m · 4h 12m · 3d 4h |
| Date | user's locale | 5 Oct 2026 |
| Relative time | with exact time on hover/focus | 5 min ago |
| Units | always shown | "4h 12m MTTR", never "4.2" |

**Time zones.** Days, months and periods are bucketed on **UTC calendar bounds**, the same bounds the dashboard queries and the assistant use (D-011). Charts with date axes say so ("Months in UTC"), and the instance's own time zone is shown beside them. Individual timestamps display in the user's locale.

---

## 7. Accessibility checklist (WCAG 2.2 AA)

- [ ] Keyboard: everything reachable and operable; visible focus (2 px `--focus` ring, 2 px offset; White on `--deep`/`--brand`)
- [ ] Semantic HTML: buttons are `<button>`, links are `<a>`, headings in order, tables are `<table>` with `<th scope>`
- [ ] Labels on every input; `alt` on meaningful images; icon-only buttons have `aria-label`
- [ ] Contrast: text ≥ 4.5:1, large text and UI components ≥ 3:1 (use the §2.2 table; don't guess)
- [ ] Colour never carries meaning alone: status = fill + icon + word
- [ ] Charts have a text summary and a "View as table" alternative
- [ ] Chat: the completed answer is announced in an `aria-live="polite"` region; the working indicator is not announced on every step
- [ ] Targets ≥ 24×24 px (AA); primary actions and chat composer ≥ 44 px tall
- [ ] Zoom to 200% and 400% (reflow) without loss of content or page-level horizontal scroll
- [ ] `prefers-reduced-motion` honoured

---

## 8. Why AI-generated UI fails real users (and the fix)

| Trap | Fix |
|---|---|
| Looks great with perfect demo data | Design and test with long assignment-group names, 0 rows, 10,000 rows, missing fields, an instance that does not answer |
| Only the happy path exists | §4 states are mandatory per view |
| Inconsistent spacing/colours per screen | Tokens only; a test fails the build on hex colours or raw `px` outside `tokens.css` |
| Off-brand "nice" colours creep in | §2.1 is the whole palette; anything else is a brand deviation |
| Numbers with no context | Every number has a unit, an "as of" time, and a definition |
| Fancy animations, slow on real devices | Motion budget §2.5; no count-ups, no parallax |
| Unlabelled icons | Icon + text, or tooltip + `aria-label` |

---

## Definition of done (per screen)

- [ ] Uses only tokens and components from this file
- [ ] Every data view has its §4 states built, including cached, unavailable and partial
- [ ] Every number shows unit, read time and a "How is this counted?" definition
- [ ] Checked with real data edge cases: long names, 0 rows, 10,000 rows, missing fields
- [ ] Filters and period are in the URL; back button works
- [ ] Accessibility checklist §7 passes, including a keyboard-only pass
- [ ] Works at 1024, 1280 and 1600 px, and reflows at 200% zoom
