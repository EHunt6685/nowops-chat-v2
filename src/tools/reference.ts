// resolve_reference: a name the user wrote becomes records on the instance. Exact match first; a
// contains match only when nothing matches exactly. The tool never picks: it returns candidates
// and says whether they may be applied as one set. The server remembers every sys_id it returned,
// and a filter may use no other. Seen live 2026-10-01: "South Africa" is three locations in one
// country, 76 open incidents; "Network" is exactly one group. Both resolve without a guess.
import { REFERENCE_KINDS } from './tables.js'
import { rows, dv, vv, listUrl } from './fetch.js'
import { ToolError, str, type ToolDef } from './types.js'
import { safeValue } from './query.js'

const MAX_CANDIDATES = 12

/** Words that describe the kind rather than name the thing. */
const FILLER = /^(the|a|an|group|groups|team|teams|support|location|locations|site|office|service|services|ci|user|person|company|department|dept|assignment)$/i

/** The name, then the name without filler words, then progressively shorter forms from the end. Each is tried in turn. */
export function nameVariants(name: string): string[] {
  const words = name.split(/\s+/).filter(Boolean)
  const out: string[] = [name]
  const core = words.filter((w) => !FILLER.test(w))
  if (core.length && core.length < words.length) out.push(core.join(' '))
  for (let n = core.length - 1; n >= 1; n--) out.push(core.slice(0, n).join(' '))
  return [...new Set(out.map((v) => v.trim()).filter((v) => v.length >= 2))]
}

export const resolveReference: ToolDef = {
  name: 'resolve_reference',
  description:
    'Look up a name the user wrote (a group, location, service, CI, user, company or department) and get the matching records with their sys_ids. ' +
    'Call this BEFORE narrowing any count, list or definition by such a name; never write a name or a sys_id into a filter that this tool did not return. ' +
    'Result says apply=true when the candidates may be used together: one exact match, or a set that shares one property (several locations in one country). ' +
    'apply=false means the name is ambiguous: show the candidates to the user with ask_user, do not choose one yourself. ' +
    `Kinds: ${Object.keys(REFERENCE_KINDS).join(', ')}.`,
  input_schema: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: Object.keys(REFERENCE_KINDS), description: 'What kind of thing the name is' },
      name: { type: 'string', description: 'The name as the user wrote it, minus filler words such as "group", "team", "location"' },
    },
    required: ['kind', 'name'],
  },
  async run(args, ctx) {
    const kind = str(args.kind, 40), name = str(args.name, 120)
    const spec = REFERENCE_KINDS[kind]
    if (!spec) throw new ToolError(`unknown kind "${kind}"; use one of ${Object.keys(REFERENCE_KINDS).join(', ')}`)
    if (name.length < 2) throw new ToolError('name is too short to look up')
    if (!safeValue(name)) throw new ToolError('name contains characters that are not allowed in a lookup (^ or =)')
    const fields = ['sys_id', ...spec.nameFields, ...spec.detail].filter((f, i, a) => a.indexOf(f) === i).join(',')
    const active = spec.activeOnly ? '^active=true' : ''
    const pick = (list: Record<string, unknown>[]) => list.map((r) => ({
      sys_id: vv(r, 'sys_id'),
      name: dv(r, spec.nameFields[0]!) || dv(r, spec.nameFields[1] ?? spec.nameFields[0]!),
      ...Object.fromEntries(spec.detail.map((d) => [d, dv(r, d)]).filter(([, v]) => v)),
    })).filter((c) => c.sys_id)

    // "network support group" is the Network group: filler words are dropped, then words from the
    // end, and each variant is tried as an exact match before any contains match. Seen live
    // 2026-10-02: the model passed "network support", nothing matched, and the question was declined.
    const variants = nameVariants(name)
    const exactFor = (v: string) => spec.nameFields.map((f, i) => `${i ? '^OR' : ''}${f}=${v}`).join('') + active
    const containsFor = (v: string) => spec.nameFields.map((f, i) => `${i ? '^OR' : ''}${f}LIKE${v}`).join('') + active
    let matched: 'exact' | 'contains' | 'none' = 'none'
    let found: ReturnType<typeof pick> = []
    let query = '', used = name
    for (const v of variants) {
      found = pick(await rows(ctx.sn, spec.table, exactFor(v), fields, MAX_CANDIDATES + 1))
      if (found.length) { matched = 'exact'; query = exactFor(v); used = v; break }
    }
    if (!found.length) for (const v of variants) {
      found = pick(await rows(ctx.sn, spec.table, containsFor(v), fields, MAX_CANDIDATES + 1))
      if (found.length) { matched = 'contains'; query = containsFor(v); used = v; break }
    }
    if (!found.length) {
      return { data: { kind, name, matched, apply: false, candidates: [], note: `No ${kind} on this instance matches "${name}" or any shorter form of it. Tell the user so; do not substitute another name.` } }
    }
    const truncated = found.length > MAX_CANDIDATES
    found = found.slice(0, MAX_CANDIDATES)

    // One exact match applies. One contains match applies only when the looked-up words appear whole in
    // the record's name ("Network" in "Network Security"), never on a prefix: "Priya" is not "Priyanka".
    // Several records that share the set-by value (one country) apply together.
    let apply = false, reason = ''
    const whole = new RegExp(`(^|[^a-z0-9])${used.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i')
    if (found.length === 1 && matched === 'exact') { apply = true; reason = 'one exact match' }
    else if (found.length === 1 && whole.test(found[0]!.name)) { apply = true; reason = 'one record, and the name appears in it whole' }
    else if (found.length === 1) { reason = `the closest ${kind} is "${found[0]!.name}", which is not the same name; confirm with the user before using it` }
    else if (spec.setBy) {
      const vals = new Set(found.map((c) => String((c as Record<string, unknown>)[spec.setBy!] ?? '')))
      if (vals.size === 1 && [...vals][0]) { apply = true; reason = `all ${found.length} share ${spec.setBy} "${[...vals][0]}"; apply them together` }
    }
    if (!apply && !reason) reason = truncated ? `more than ${MAX_CANDIDATES} ${kind}s match; ask the user to be more specific` : `${found.length} different ${kind}s match; ask the user which one`
    for (const c of found) ctx.turn.resolved.set(c.sys_id, { kind, name: c.name })
    return {
      data: { kind, name, matched, apply, reason, count: found.length, candidates: found, sys_ids: apply ? found.map((c) => c.sys_id) : undefined },
      url: listUrl(ctx.sn.instanceUrl, spec.table, query),
    }
  },
}
