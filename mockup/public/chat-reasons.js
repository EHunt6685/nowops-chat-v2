// Why the chatbot said no, keyed by the server's gateReason. One copy for every page that hosts
// the chat panel in app-preview.html, kept as its own file so a new reason has one place to land.
// Tone: 'soft' offers example questions; 'off' means something on the instance side is down.
window.NOWOPS_REASON = {
  too_few_tokens: ['A word or two is not enough to search on. Ask a full question.', 'soft'],
  servicenow_unavailable: ['The ServiceNow instance did not answer. Live counts and articles both need it.', 'off'],
  metric_unavailable: ['The count was attempted, but the instance rejected the query.', 'off'],
  model_declined: ['Nothing on this instance answered this. The reply says what was looked for and what was missing.', 'soft'],
  ungrounded: ['The model wrote a figure that no query result contained, so the answer was withheld rather than shown. Ask for the number on its own.', 'off'],
  agent_failed: ['The model or the instance did not answer in time. Try again.', 'off'],
  count_unmatched: ['No dashboard tile or NowOps definition matches that number, and no query could be written for it without guessing. Try the tile\'s own name, or drop the breakdown.', 'soft'],
  out_of_scope: ['That is not about this instance. Ask for a live count from a dashboard definition, or how to do something from the knowledge base.', 'soft'],
  needs_page: ['That question is about your own queue or the open ticket, which only the Resolve page has loaded. Open your queue there and ask again.', 'soft'],
  definition_no_data: ['The definition and its table exist, but nothing is recorded for it on this instance yet. The dashboard tile shows "no data yet" for the same reason.', 'off'],
  definition_unavailable: ['The matching definition exists but the instance scan could not confirm its table or fields, so the dashboard tile is off too. Re-run the scan.', 'off'],
}
