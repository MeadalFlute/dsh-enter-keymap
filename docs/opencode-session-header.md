# OpenCode Go requires `x-opencode-session`; DSH never sends it

Ready-to-paste material for [deepseek-ai/deepseek-harness discussion #5495](https://github.com/deepseek-ai/deepseek-harness/discussions/5495).
Every claim below is backed by a script in [`../tools/`](../tools) that you can re-run.

**TL;DR** — The pi-ai adapter never emits `x-opencode-session` on any protocol, for any
route, including `opencode-go`. Until it does, every OpenCode Go request without a manually
configured header is rejected with
`Request is missing x-opencode-session and cannot be routed efficiently`.
This is a DSH-side gap, not a provider-side one.

## Evidence

Run against pi-ai `0.85.1` as vendored by DSH `0.1.6-alpha.2`:

```sh
node tools/probe-pi-ai-headers.mjs <pi-ai/dist/index.js>
node tools/verify-opencode-session-header.mjs <pi-ai/dist/index.js>
```

`probe-pi-ai-headers.mjs` drives the real protocol implementations against a local capture
server and prints the headers that actually reach the wire:

| scenario | headers observed on the wire |
| --- | --- |
| `model.headers` (what `providers.<route>.headers` becomes) | ✅ static headers pass through unchanged |
| `model.headers` + `options.headers` | ✅ `options.headers` win (merged last) |
| `sessionId` + `provider: probe` | ❌ no session header of any kind |
| `sessionId` + `provider: opencode-go` | ❌ no session header of any kind |
| `sessionId` + `provider: opencode` | ❌ no session header of any kind |

`verify-opencode-session-header.mjs` goes one step further and replays the adapter's own
construction (`requestHeaders(profile.headers)` → `models.streamSimple(model, ctx, { …, headers })`)
for `minimax-m3` on `anthropic-messages` — the path the reporter's failing requests take:

```
请求数: 1
url: /v1/v1/messages?beta=true
x-opencode-session: 01J8Z9K3M4N5P6Q7R8S9T0V1W2   ← only because it was configured statically
user-agent: deepseek-harness/0.1.6-alpha.2 (+https://github.com/deepseek-ai/deepseek-harness)
x-api-key 是否发送: true
```

## Root cause, with pointers

1. **pi-ai only sends session affinity headers when a compat switch is on, and it hardcodes
   that switch off for the openai-completions detector.**
   - `@earendil-works/pi-ai/dist/api/openai-completions.js:557` — the only session-header
     emission site for this protocol, gated on `compat.sendSessionAffinityHeaders`.
   - `…/openai-completions.js:1309` — `detectCompat()` returns `sendSessionAffinityHeaders: false`
     unconditionally. The `opencode` / `opencode.ai` cases listed in `isNonStandard`
     (`:1261-1262`) affect other compat fields, **not** this one.
   - Even when enabled, the names it would set are `session_id`, `x-client-request-id`,
     `x-session-affinity` (`:557-566`) — none of which is `x-opencode-session`.
     The anthropic path emits `x-session-affinity` (`anthropic-messages.js:725`), likewise
     not the required name.
2. **`x-opencode-session` does not exist anywhere in the dependency tree.** A case-insensitive
   search over the whole pnpm store (pi-ai, `dsh-llm`, `dsh-llm-pi-ai`, every adapter) returns
   zero matches.
3. **`GenerateOptions` has no `headers` field** (`@deepseek-ai/dsh-llm/lib/types/types.d.ts:439-479`),
   so the `llm/stream` waterfall event cannot inject one either — a listener can only rewrite
   fields that exist. The only header lever DSH exposes per route is the static
   `PiAiProviderProfile.headers` (`dsh-llm-pi-ai/lib/types/config.d.ts:113`).
4. **`opencode-go` spans three protocols** (`providers/opencode-go.js`): `anthropic-messages`
   (minimax, qwen), `openai-completions` (glm, deepseek, hy, longcat, mimo, space-bunny),
   `openai-responses` (grok, gpt, muse). Whatever a fix does, it has to cover all three — which
   matches the reporter's "session information arrives on some model paths, but is missing on
   others".

## Why a static header is not a real fix

`providers.<route>.headers` works, but it is one fixed value for every conversation, while the
requirement is "a stable session ID **per conversation**". DSH already passes exactly that value
into the adapter on every call — `GenerateOptions.sessionId`
(`dsh-llm/lib/types/types.d.ts:472`), handed to pi-ai as
`{ sessionId: String(options.sessionId) }` (`dsh-llm-pi-ai/lib/index.js:1917`), where pi-ai then
routes it into cache-affinity payload fields and (conditionally) affinity headers. The value is
present; only the mapping to `x-opencode-session` is missing.

## Suggested fix (adapter-side, small)

In `dsh-llm-pi-ai`, map the existing session identity onto the header the route requires, e.g.
extend `PiAiCompatProfile` with `sessionHeaderName` (or a boolean
`sendOpencodeSessionHeader`) and thread it through `requestHeaders()` so
`profile.headers` stays user-owned while DSH contributes:

```js
// dsh-llm-pi-ai, alongside requestHeaders()
headers['x-opencode-session'] = String(options.sessionId)
```

for routes whose baseURL host is `opencode.ai` (or whose provider id is `opencode`/`opencode-go`).
The other requirements from the same doc already hold: DSH sends a self-identifying
`user-agent` (`deepseek-harness/<version> (+url)`, from `dsh-llm/lib/types/attribution.js`), and
`user-agent` is a reserved attribution header, so a deployment cannot override it by accident.

## Interim workaround for users

Add a static header under the route in `$DSH_HOME/settings.yaml` and restart:

```yaml
llm-pi-ai:
  providers:
    opencode-go:
      headers:
        x-opencode-session: <a stable id of your choosing>
```

Note that the Settings → Plugins page in the Web GUI does **not** render a card for the
`llm-pi-ai` namespace, so this can only be done by editing the file.

---

# 中文摘要（给本仓库读者）

- **结论**：DSH 在**任何协议、任何路由**上都不发 `x-opencode-session`，`opencode-go` 也不例外。
  这是 DSH 侧缺口，不是 opencode 侧问题。
- **证据**：`tools/probe-pi-ai-headers.mjs`（5 个场景抓包）+ `tools/verify-opencode-session-header.mjs`
  （复刻 adapter 真实构造，覆盖 `minimax-m3` 的 anthropic 路径）。
- **根因**：pi-ai 的 `sendSessionAffinityHeaders` 在 openai-completions 检测里被硬编码为 `false`
  （`openai-completions.js:1309`），且它即便开启也只发 `session_id` / `x-client-request-id` /
  `x-session-affinity`；整个依赖树搜不到 `x-opencode-session`。
- **为什么静态配置不算真修**：需求是「每个会话一个稳定 ID」，而 `providers.<route>.headers`
  只有一个固定值。DSH 其实已经把 per-conversation 值传进 adapter 了
  （`GenerateOptions.sessionId`），缺的只是把它映射成这个头。
- **建议修法**：在 `dsh-llm-pi-ai` 里给 `opencode*` 路由补一个 session 头映射，协议无关。
