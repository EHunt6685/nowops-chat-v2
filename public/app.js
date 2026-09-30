const logEl = document.getElementById('log')
const form = document.getElementById('composer')
const input = document.getElementById('q')
const healthEl = document.getElementById('health')
const conversationId = crypto.randomUUID()

function bubble(cls, text) {
  const el = document.createElement('div')
  el.className = `msg ${cls}`
  el.textContent = text
  logEl.appendChild(el)
  logEl.scrollTop = logEl.scrollHeight
  return el
}

function link(href, text) {
  const a = document.createElement('a')
  a.href = href
  a.target = '_blank'
  a.rel = 'noopener'
  a.textContent = text
  return a
}

/** Article answers cite KB numbers; metric answers show the query that produced them. */
function renderSources(el, data) {
  const line = document.createElement('div')
  line.className = 'sources'

  if (data.kind === 'metric' && data.metric) {
    const m = data.metric
    const agg = m.aggregate === 'count' ? 'count' : `${m.aggregate}(${m.field})`
    line.append(`Source: ${m.table} · ${agg} · `)
    line.appendChild(link(m.url, 'open in abhrademo4 →'))
    el.appendChild(line)

    const f = document.createElement('div')
    f.className = 'filter'
    f.textContent = m.filter || '(no filter — whole table)'
    el.appendChild(f)
    return
  }

  if (!data.grounded || !data.sources || data.sources.length === 0) {
    line.classList.add('none')
    // Worded for what the model said the question was, not for which lane a regex chose.
    const why = {
      servicenow_unavailable: 'Knowledge base unreachable — not answered',
      metric_unavailable: 'Could not run that query — not answered',
      definition_unavailable: 'Defined, but not available on this instance — not answered',
      definition_no_data: 'Defined, but nothing recorded for it on this instance yet — not answered',
      count_unmatched: 'No dashboard definition fits and no safe query could be written — not answered',
      out_of_scope: 'Not about this instance — not answered',
      needs_page: 'About your own queue or ticket; ask from the Resolve page — not answered',
      too_few_tokens: 'Too short to search on — not answered',
    }
    line.textContent = why[data.gateReason] ?? 'No knowledge base match — not answered'
    el.appendChild(line)
    return
  }

  line.append('Sources: ')
  data.sources.forEach((s, i) => {
    if (i) line.append(' · ')
    const a = link(s.url, s.label || s.title)
    a.title = s.title
    line.appendChild(a)
  })
  el.appendChild(line)
}

async function loadHealth() {
  try {
    const h = await (await fetch('/api/health')).json()
    healthEl.textContent = h.ok ? `ready · ${h.model}` : 'ServiceNow unreachable'
    // Stub mode is coloured as a warning so nobody mistakes canned text for a real answer.
    healthEl.className = `pill ${!h.ok ? 'bad' : h.llmMode === 'stub' ? 'warn' : 'ok'}`
  } catch {
    healthEl.textContent = 'server unreachable'
    healthEl.className = 'pill bad'
  }
}

form.addEventListener('submit', async (e) => {
  e.preventDefault()
  const message = input.value.trim()
  if (!message) return
  input.value = ''
  bubble('user', message)

  const pending = bubble('bot typing', 'Working…')

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message, conversationId }),
    })
    const data = await res.json()
    pending.className = 'msg bot'
    pending.textContent = ''

    const body = document.createElement('div')
    if (data.kind === 'metric') body.className = 'metric'
    body.textContent = data.answer ?? data.error ?? 'No response.'
    pending.appendChild(body)

    renderSources(pending, data)
  } catch {
    pending.className = 'msg bot'
    pending.textContent = 'Request failed.'
  }
})

loadHealth()
