// search_knowledge and get_article. The model may search more than once with its own words; each
// result's articles are what a citation of that result shows as sources.
import { makeSearch, stripHtml } from '../servicenow/search.js'
import { relevant } from '../relevance.js'
import { rows, dv, vv } from './fetch.js'
import { ToolError, str, num, type ToolDef } from './types.js'
import { SYS_ID_RE, safeValue } from './query.js'

const SNIPPET = 700

export const searchKnowledge: ToolDef = {
  name: 'search_knowledge',
  description:
    'Full-text search of the published knowledge base. Returns up to 5 articles with a snippet. Use the vocabulary an article would use ("leaver offboarding account removal", not "someone is leaving"); ' +
    'if the first search misses, search once more with different words before saying there is no article. An article about a different system than the user\'s is the wrong article. ' +
    'Answers about procedures must come from these articles and cite the result id.',
  input_schema: {
    type: 'object',
    properties: { query: { type: 'string', description: 'Keywords, 2-8 words' }, limit: { type: 'number', description: 'Max articles, default 5' } },
    required: ['query'],
  },
  async run(args, ctx) {
    const query = str(args.query, 200), limit = num(args.limit, 5, 5)
    if (query.length < 3) throw new ToolError('query is too short')
    const search = makeSearch(ctx.sn)
    const found = relevant(query, await search.search(query)).slice(0, limit)
    return {
      data: {
        query, found: found.length,
        articles: found.map((a) => ({ number: a.label, title: a.title, snippet: a.body.slice(0, SNIPPET), url: a.url })),
        note: found.length ? undefined : 'No published article matched these words. Try once more with the knowledge base\'s own vocabulary, or tell the user no article covers it.',
      },
      articles: found,
    }
  },
}

export const getArticle: ToolDef = {
  name: 'get_article',
  description: 'The full text of one published knowledge article, by KB number (KB0010141) or sys_id. Use when a snippet is not enough to answer.',
  input_schema: { type: 'object', properties: { article: { type: 'string', description: 'KB number or sys_id' } }, required: ['article'] },
  async run(args, ctx) {
    const key = str(args.article, 40)
    if (!key || !safeValue(key)) throw new ToolError('article must be a KB number or sys_id')
    const q = SYS_ID_RE.test(key) ? `sys_id=${key}` : `number=${key}^workflow_state=published`
    const list = await rows(ctx.sn, 'kb_knowledge', q, 'sys_id,number,short_description,text,sys_updated_on,kb_knowledge_base', 3)
    if (!list.length) throw new ToolError(`no published article ${key} on this instance`)
    const articles = list.map((r) => ({ id: vv(r, 'sys_id'), label: dv(r, 'number'), title: dv(r, 'short_description'), body: stripHtml(dv(r, 'text')).slice(0, 6000), url: `${ctx.sn.instanceUrl}/kb_view.do?sys_kb_id=${vv(r, 'sys_id')}` }))
    return {
      data: { found: articles.length, note: articles.length > 1 ? 'More than one article carries this number; both are shown. Cite the one that fits the question.' : undefined, articles: articles.map((a) => ({ number: a.label, title: a.title, updated: dv(list[0]!, 'sys_updated_on'), text: a.body, url: a.url })) },
      articles,
    }
  },
}
