/**
 * 抓包工具（与插件运行时无关，只为复现 OpenCode Go 的 session 头问题）。
 *
 * 起一个本地 HTTP 服务器当假 provider，返回最小的 OpenAI chat.completions 流式响应，
 * 再用 pi-ai 的 createModels()/createProvider() 走真实协议实现发请求，
 * 逐个场景打印**实际到达线路的头**。
 *
 * 用法：
 *   node tools/probe-pi-ai-headers.mjs <pi-ai dist/index.js 的绝对路径>
 *
 * 例（DSH Launcher 布局）：
 *   node tools/probe-pi-ai-headers.mjs \
 *     "$DSH_HOME/../versions/0.1.6-alpha.2/node_modules/.pnpm/@earendil-works+pi-ai@0.85.1_ws@8.21.3_zod@4.6.5/node_modules/@earendil-works/pi-ai/dist/index.js"
 *
 * 结论（pi-ai 0.85.1）：
 *   - model.headers  → 原样上线路（DSH 的 providers.<route>.headers 走这条）
 *   - options.headers → 覆盖 model.headers
 *   - sessionId      → **不发任何 session 类头**，provider 是 opencode-go / opencode 也一样
 *     （compat.sendSessionAffinityHeaders 在 openai-completions.js 里硬编码 false；
 *      且它只会发 x-session-id / x-client-request-id / x-session-affinity / session_id，
 *      都不是 OpenCode Go 要求的 x-opencode-session）
 */
import { createServer } from 'node:http'

const base = process.argv[2]
if (!base) {
  console.error('usage: node tools/probe-pi-ai-headers.mjs <absolute path to pi-ai/dist/index.js>')
  process.exit(2)
}
const pi = await import(base)
const api = await import(`${base.slice(0, base.lastIndexOf('/') + 1)}api/openai-completions.js`)

/** 收到的请求。 */
const seen = []
const PORT = 18999

const server = createServer((req, res) => {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = Array.isArray(v) ? v.join(',') : String(v)
  req.resume()
  req.on('end', () => {
    seen.push({ url: req.url, headers })
    const chunk = JSON.stringify({
      id: 'x', object: 'chat.completion.chunk', created: 1, model: 'probe-model',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'ok' }, finish_reason: null }],
    })
    const done = JSON.stringify({
      id: 'x', object: 'chat.completion.chunk', created: 1, model: 'probe-model',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.end(`data: ${chunk}\n\ndata: ${done}\n\ndata: [DONE]\n\n`)
  })
})

await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log('fake provider listening on', PORT)

function modelFor(provider, extra = {}) {
  return {
    id: 'probe-model', name: 'Probe', provider, api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${PORT}/v1`, reasoning: false, input: ['text'],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 8192, maxTokens: 1024,
    ...extra,
  }
}

async function run(label, providerId, modelExtra, options) {
  seen.length = 0
  const model = modelFor(providerId, modelExtra)
  const models = pi.createModels()
  models.setProvider(pi.createProvider({
    id: providerId,
    name: providerId,
    api: { 'openai-completions': api },
    models: [model],
    // ProviderAuth.apiKey.resolve 必须返回 { auth: { apiKey } }，否则 pi-ai 报 "reading 'apiKey'"
    auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: { apiKey: 'probe-key' } }) } },
  }))
  const stream = models.streamSimple(model, { messages: [{ role: 'user', content: 'hi' }] }, { ...options })
  for await (const chunk of stream) {
    if (chunk?.type === 'error') console.log(`  [${label}] ERROR CHUNK: ${JSON.stringify(chunk.error?.errorMessage ?? chunk).slice(0, 300)}`)
  }
  const got = seen[0]?.headers ?? {}
  const interesting = Object.fromEntries(Object.entries(got).filter(([k]) =>
    k.includes('session') || k.includes('opencode') || k === 'user-agent' || k.startsWith('x-probe')))
  console.log(`\n[${label}] 请求数=${seen.length}`)
  console.log('  关注的头:', JSON.stringify(interesting, null, 2))
  console.log('  全部头名:', Object.keys(got).sort().join(', '))
}

await run('1 只有 model.headers', 'probe', { headers: { 'x-probe-static': 'from-model', 'x-opencode-session': 'session-from-model' } }, {})
await run('2 model.headers + options.headers', 'probe', { headers: { 'x-probe-both': 'model' } }, { headers: { 'x-probe-both': 'options', 'x-probe-options': 'yes' } })
await run('3 sessionId + provider=probe', 'probe', {}, { sessionId: 'sess-123' })
await run('4 sessionId + provider=opencode-go', 'opencode-go', {}, { sessionId: 'sess-123' })
await run('5 sessionId + provider=opencode', 'opencode', {}, { sessionId: 'sess-123' })

server.close()
