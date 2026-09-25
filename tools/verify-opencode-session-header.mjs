/**
 * 抓包工具（与插件运行时无关）：验证 DSH 的 providers.<route>.headers
 * 能否把 x-opencode-session 送到对端，并观察 user-agent 的真实取值。
 *
 * 复刻 dsh-llm-pi-ai adapter 的请求构造：
 *   requestHeaders(profile.headers) → models.streamSimple(model, ctx, { …, headers })
 * 模型取真实目录里的 minimax-m3（anthropic-messages），正是用户报错的那条路径。
 *
 * 用法：
 *   node tools/verify-opencode-session-header.mjs <pi-ai dist/index.js 绝对路径>
 *
 * 期望输出：
 *   x-opencode-session: <你配置的值>        ← profile headers 确实上线路
 *   user-agent: deepseek-harness/<版本> (+…)  ← 注意：pi-ai 自己发的 "pi (…)" 被覆盖
 *   请求数: 1
 */
import { createServer } from 'node:http'

const base = process.argv[2]
if (!base) {
  console.error('usage: node tools/verify-opencode-session-header.mjs <absolute path to pi-ai/dist/index.js>')
  process.exit(2)
}
const pi = await import(base)
const anthropicApi = await import(`${base.slice(0, base.lastIndexOf('/') + 1)}api/anthropic-messages.js`)

const seen = []
const PORT = 18997

const server = createServer((req, res) => {
  const headers = {}
  for (const [k, v] of Object.entries(req.headers)) headers[k.toLowerCase()] = String(v)
  req.resume()
  req.on('end', () => {
    seen.push({ url: req.url, headers })
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write(
      `event: message_start\ndata: ${JSON.stringify({ type: 'message_start', message: { id: 'm1', type: 'message', role: 'assistant', model: 'minimax-m3', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`,
    )
    res.write(`event: content_block_start\ndata: ${JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } })}\n\n`)
    res.write(`event: content_block_delta\ndata: ${JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } })}\n\n`)
    res.write(`event: content_block_stop\ndata: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`)
    res.write(`event: message_delta\ndata: ${JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } })}\n\n`)
    res.write(`event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`)
    res.end()
  })
})
await new Promise((r) => server.listen(PORT, '127.0.0.1', r))
console.log('假 anthropic 端点:', `http://127.0.0.1:${PORT}/v1/messages`)

/** minimax-m3 在 pi-ai 目录里走 anthropic-messages。 */
const model = {
  id: 'minimax-m3', name: 'MiniMax-M3', provider: 'opencode-go', api: 'anthropic-messages',
  baseUrl: `http://127.0.0.1:${PORT}/v1`, reasoning: false, input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 1000000, maxTokens: 131072,
}

/** 复刻 dsh-llm 的 requestHeaders()：usER-AGENT 是保留头，profile 里的会被丢弃。 */
function requestHeaders(headers) {
  const attribution = { 'user-agent': 'deepseek-harness/0.1.6-alpha.2 (+https://github.com/deepseek-ai/deepseek-harness)' }
  const reserved = new Set(Object.keys(attribution))
  return {
    ...Object.fromEntries(Object.entries(headers ?? {}).filter(([name]) => !reserved.has(name.toLowerCase()))),
    ...attribution,
  }
}

const models = pi.createModels()
models.setProvider(pi.createProvider({
  id: 'opencode-go',
  name: 'OpenCode Go',
  api: { 'anthropic-messages': anthropicApi },
  models: [model],
  auth: { apiKey: { name: 'probe', resolve: async () => ({ auth: { apiKey: 'probe-key' } }) } },
}))

/** 模拟 settings.yaml 里 providers.opencode-go.headers。 */
const profileHeaders = {
  'x-opencode-session': '01J8Z9K3M4N5P6Q7R8S9T0V1W2',
  // 故意写一个 user-agent，用来证明它会被 attribution 覆盖掉
  'user-agent': 'my-coding-agent/1.0',
}

const stream = models.streamSimple(
  model,
  { messages: [{ role: 'user', content: 'hi' }] },
  { sessionId: '01J8Z9K3M4N5P6Q7R8S9T0V1W2', headers: requestHeaders(profileHeaders) },
)
for await (const chunk of stream) {
  if (chunk?.type === 'error') console.log('ERROR:', chunk.error?.errorMessage)
}

const got = seen[0]?.headers ?? {}
console.log('\n请求数:', seen.length)
console.log('url:', seen[0]?.url)
console.log('x-opencode-session:', got['x-opencode-session'] ?? '(缺失)')
console.log('user-agent:', got['user-agent'] ?? '(缺失)')
console.log('x-api-key 是否发送:', got['x-api-key'] !== undefined)
console.log('\n全部头名:', Object.keys(got).sort().join(', '))

server.close()
