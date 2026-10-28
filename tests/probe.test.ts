import { expect, mock, test } from 'claude-code/testing'
import { AGENT_PROMPT, AGENT_SPEC, BWRAP_ARGS, CONTEXT_SPEC, TOOL_SPEC, failureText, park, withUsage, usageFor, bodyOf, formatContext, formatResults, handbackSendersOf, lengthOf, outcomeOf, questionPrompt, recentExchange, rewriteRequest, SANDBOXES, shortenPrompt, shQuote, taskIdsOf, wrapCommand } from '../hooks/register.js'

const AGENT = 'probe:probe'
const TOOL = 'mcp__probe__probe'
const CONTEXT = 'mcp__probe__context'

type Script = { answer?: string; reason?: string; parks?: number; never?: boolean; deny?: string; then?: Script }

/**
 * The engine beneath the plugin, as far as the plugin reaches it: registration,
 * agent.spawn (an agent id per call), session.send (a finished subagent is resumed:
 * its next run follows `then` of its script), the `sleep` park (the subagents finish
 * there, by script), bwrap, TaskStop and the clock.
 */
function world($: any, on: any, options: { bwrap?: boolean; seatbelt?: boolean; sleep?: boolean; send?: 'refuse' | 'throw'; shorten?: 'ok' | 'long' | 'throw' | 'none'; messages?: any[] | 'throw' | 'deny'; usage?: string | 'missing'; sleepFails?: number; script?: (prompt: string, n: number) => Script; agents?: any[]; listThrows?: boolean; clockThrows?: boolean; names?: Record<string, string>; trace?: boolean; bashOut?: { stdout: string; stderr?: string; isError?: boolean } } = {}) {
  if (options.clockThrows) on('clock.now', () => { throw new Error('boom') })
  const w = {
    clock: options.clockThrows ? (undefined as any) : mock.clock(on),
    registered: { agent: undefined as any, tool: undefined as any, context: undefined as any, output: undefined as any, commands: [] as any[] },
    messageCalls: [] as any[],
    reads: [] as string[],
    spawns: [] as any[],
    live: new Map<string, { prompt: string; script: Script; parks: number }>(),
    finished: new Map<string, Script>(),
    sends: [] as Array<{ to: unknown; text: string; origin: unknown }>,
    completes: [] as any[],
    maxLive: 0,
    stopped: [] as string[],
    bash: [] as string[],
    calls: [] as string[],
    ran: [] as string[][],
    parks: 0,
    traced: [] as any[],
    toasts: [] as string[],
    invalidated: [] as any[],
    sleepFails: options.sleepFails ?? 0,
    onPark: [] as Array<() => Promise<void>>,
    agents: options.agents ?? ([] as any[]),
  }
  const script = options.script ?? ((p: string) => ({ answer: 'answer: ' + p }))
  on('agent.register', (_$: any, e: any) => { w.registered.agent = e; return { value: { agent: AGENT } } })
  on('command.register', (_$: any, e: any) => { w.registered.commands.push(e); return { value: { command: e.name } } })
  on('tool.register', (_$: any, e: any) => {
    if (e.name === 'context') w.registered.context = e
    else if (e.name === 'output') w.registered.output = e
    else w.registered.tool = e
    return { value: { tool: 'mcp__probe__' + e.name } }
  })
  on('session.messages', (_$: any, e: any) => {
    w.messageCalls.push(e)
    if (options.messages === 'throw') throw new Error('transcript down')
    if (options.messages === 'deny') return { value: { deny: 'unreadable' } }
    return { value: options.messages ?? [] }
  })
  on('ui.toast', (_$: any, e: any) => { w.toasts.push(String(e.text ?? e)); return { value: undefined } })
  on('session.start', (_$: any, e: any) => ({ cwd: e.cwd }))
  on('agent.list', () => {
    if (options.listThrows) throw new Error('list down')
    return { value: [...w.agents, ...[...w.live.keys()].map((id) => ({ id, type: AGENT, status: 'running', description: 'probe', ...(options.names?.[id] ? { name: options.names[id] } : {}) }))] }
  })
  on('agent.offer', () => ({ isOffered: true }))
  on('prompt.attachment', (_$: any, e: any) => ({ text: e.text }))
  if (options.trace) mock.env(on, { PROBE_TRACE: '/log/probe-trace.log' })
  on('fs.read', (_$: any, e: any) => {
    w.reads.push(String(e.path))
    if (options.usage === 'missing') throw new Error('ENOENT')
    return { value: options.usage ?? 'USAGE-RULES\nwhen to use probe' }
  })
  on('prompt.section', (_$: any, e: any) => ({ text: e.text }))
  on('ui.invalidate', (_$: any, e: any) => { w.invalidated.push(e.event ?? e); return { value: undefined } })
  on('prompt.submit', (_$: any, e: any) => ({ text: e.text }))
  on('turn.complete', (_$: any, e: any) => ({ text: e.answer }))
  // The plugin's $.agent.spawn reaches the bottom as the Agent tool call (run_in_background) and reads
  // the tool's record ({ agentId, status: 'async_launched' }) from the answer's `result`.
  on('agent.spawn', (_$: any, e: any) => {
    const n = w.spawns.length + 1
    const s = script(e.prompt.replace(/\n\n（結果の上限: \d+ 字）$/, ''), n)
    w.spawns.push(e)
    if (s.deny) return { deny: s.deny }
    const agentId = `agent-${n}`
    w.live.set(agentId, { prompt: e.prompt, script: s, parks: 0 })
    w.maxLive = Math.max(w.maxLive, w.live.size)
    return { model: e.model ?? 'haiku', agentId, result: { status: 'async_launched', agentId, description: e.description, prompt: e.prompt, outputFile: '/tmp/out' }, text: 'launched' }
  })
  // As the engine resumes a finished subagent for a message: its agent type must be offered (agent.offer).
  on('session.send', async (_$: any, e: any) => {
    w.sends.push({ to: e.to, text: e.text, origin: e.origin })
    if (options.send === 'throw') throw new Error('send down')
    if (options.send === 'refuse') return { isDelivered: false, reason: 'nobody by that name' }
    const offered = await $.agent.offer({ agent: AGENT, description: 'd', source: 'plugin', provider: { plugin: 'probe', tier: 'user' } } as any)
    if (!offered.isOffered) return { isDelivered: false, reason: `Agent type '${AGENT}' is not offered in this session.` }
    const id = String(e.to)
    const prev = w.finished.get(id)
    if (!prev) return { isDelivered: false, reason: 'no such agent' }
    w.finished.delete(id)
    w.live.set(id, { prompt: e.text, script: prev.then ?? { answer: 'rewritten' }, parks: 0 })
    return { isDelivered: true }
  })
  const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
  on('model.complete', (_$: any, e: any) => {
    w.completes.push(e)
    if (options.shorten === 'throw') throw new Error('model down')
    if (options.shorten === 'ok') return { value: { isAnswered: true, text: ' 要約: ' + 'k'.repeat(100) + ' ', usage } }
    if (options.shorten === 'long') return { value: { isAnswered: true, text: 'L'.repeat(9000), usage } }
    return { value: { isAnswered: false, reason: 'api-error', status: 500, error: 'server_error', usage } }
  })
  on('tool.call', { tool: 'TaskStop' }, (_$: any, e: any) => { w.stopped.push(e.task_id); w.live.delete(e.task_id); return { result: { message: 'stopped' }, text: 'stopped' } })
  on('tool.call', (_$: any, e: any) => {
    w.calls.push(e.tool)
    if (e.tool === 'Bash') w.bash.push(e.command)
    if (e.tool === 'Bash' && options.bashOut) {
      const b = options.bashOut
      if (b.isError) return { isError: true, result: 'Exit code 3\n' + b.stdout, text: 'Exit code 3\n' + b.stdout }
      return { result: { stdout: b.stdout, stderr: b.stderr ?? '', interrupted: false }, text: b.stdout }
    }
    return { result: 'ok', text: 'ok' }
  })
  on('process.run', async (_$: any, e: any) => {
    const argv: string[] = e.argv
    w.ran.push(argv)
    if (argv[0] === 'bwrap') return { value: { exitCode: options.bwrap === false ? 1 : 0, stdout: '', stderr: options.bwrap === false ? 'no bwrap' : '', isStdoutTruncated: false, isStderrTruncated: false } }
    if (argv[0] === '/usr/bin/sandbox-exec' || argv[0] === 'cmd') {
      return { value: { exitCode: options.seatbelt === true && argv[0] !== 'cmd' ? 0 : 127, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'sh' && String(argv[2]).includes('cat >>')) {
      w.traced.push(JSON.parse(e.init.stdin))
      return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
    }
    if (argv[0] === 'sleep' && options.sleep === false) throw new Error('spawn sleep ENOENT')
    if (argv[0] === 'sleep' && w.sleepFails > 0) {
      w.sleepFails--
      throw new Error('sleep killed')
    }
    if (argv[0] === 'sleep' || argv[0] === 'ping') {
      if (++w.parks > 400) throw new Error('test: the park loop does not end')
      await w.clock.advance(60_000) // one park = one minute on the mocked clock
      for (const fn of w.onPark) await fn()
      for (const [id, a] of [...w.live]) {
        a.parks++
        if (a.script.never || a.parks < (a.script.parks ?? 1)) continue
        w.live.delete(id)
        w.finished.set(id, a.script)
        await $.turn.complete({ turnId: 't-' + id, agentId: id, answer: a.script.answer ?? '', durationMs: 5, isAborted: a.script.reason === 'aborted', reason: (a.script.reason ?? 'answer') as any })
      }
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return w
}

const offerInput = (agent: string) => ({ agent, description: 'd', source: 'plugin', provider: { plugin: 'x', tier: 'user' } }) as any
const start = ($: any) => $.session.start({ cwd: '/tmp', surface: null, isInteractive: false })
const probe = ($: any, input: Record<string, unknown>) => ($.tool.call as any)({ tool: TOOL, ...input })
const asAgent = ($: any, agentId: string | undefined, input: Record<string, unknown>) => ($.tool.call as any)({ ...input, ...(agentId ? { agentId } : {}) })
// tool.check of a Bash call (the engine's own check found it read-only or not)
const bashCheck = ($: any, agentId: string | undefined, isReadOnly: boolean) =>
  ($.tool.check as any)({ tool: 'Bash', input: { command: 'x' }, ...(agentId ? { agentId } : {}), ...(isReadOnly ? { isReadOnly: true } : {}) })

// ------------------------------------------------------------------ registration

test('session.start registers the hidden probe agent and the probe tool', async ($, on) => {
  const w = world($, on)
  await start($)
  const a = w.registered.agent
  expect(a.name).toBe('probe')
  expect(a.model).toBe('haiku')
  expect(a.effort).toBe('low')
  expect(a.omitClaudeMd).toBe(true)
  expect(a.tools).toEqual(['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', CONTEXT])
  expect(a.prompt).toContain('なるべく1回の bash にまとめ')
  expect(a.prompt).toContain('依存しない操作は並列に呼ぶ')
  expect(a.prompt).not.toContain('codemode')
  expect(a.prompt).toContain('結論を先に')
  expect(a.prompt).toContain('既定では 2000 字以内で書く')
  expect(a.prompt).toContain('結果の上限: N 字')
  expect(a.prompt).toContain('長さや形の指定があればそれに従う')
  expect(a.prompt).toContain('前置き・経過・使ったコマンド・注意書きは書かない')
  const t = w.registered.tool
  expect(t.name).toBe('probe')
  expect(t.inputSchema.required).toEqual(['questions'])
  expect(t.inputSchema.properties.questions.minItems).toBe(1)
  expect(t.inputSchema.properties.model).toBeUndefined()
  expect(JSON.stringify(t)).not.toContain('sonnet')
  expect(t.inputSchema.properties.max_chars).toMatchObject({ type: 'integer', minimum: 500, maximum: 8000 })
  expect(t.inputSchema.required).not.toContain('max_chars')
  expect(t.isDeferred).toBe(false)
  expect(t.description).toBe(
    '読み取り専用のシェルで調べて、結論か関係する原文の引用だけを返す。ファイルの検索、コマンドやテストの実行、Web 検索ができ、条件を明示すれば分岐を含む手順も任せられる。' +
      '向くのは、どこにあるか分からないものを広く探すとき、多くのファイルにまたがるとき、長い出力（ログ、コマンドの出力）から要点だけ欲しいとき、Web で調べるとき。これから編集する箇所と、すぐ済む確認は自分でやる。' +
      '判断は、基準を問いに書けるなら任せられる。会話全体の文脈や好みに依る判断は任せず、材料集めに使う。' +
      '答えの事実はそのまま使ってよい。確かめていない推測には「推測」と書かれ、見つからなかったときは探した範囲が書かれる。',
  )
  expect(Object.keys(t.inputSchema.properties)).toEqual(['questions', 'cwd', 'max_chars', 'context', 'effort'])
  expect(t.inputSchema.properties.questions.description).toContain('複数書くと並列に処理され、結果はまとめて返る（最大4件同時')
  expect(t.inputSchema.properties.questions.description).toContain('同じディレクトリでビルドする問いは並べない')
  expect(t.inputSchema.properties.cwd.description).toBe('実行ディレクトリ。省略すると現在の作業ディレクトリ。')
  expect(t.inputSchema.properties.max_chars.description).toContain('500〜8000')
  expect(t.inputSchema.additionalProperties).toBe(false)
  expect(TOOL_SPEC.description).toBe(t.description)
  expect(AGENT_SPEC.prompt).toBe(AGENT_PROMPT)
})

test('agent.offer hides the probe agent from the model and leaves the others', async ($, on) => {
  world($, on)
  const input = (agent: string) => ({ agent, description: 'd', source: 'plugin', provider: { plugin: 'x', tier: 'user' } }) as any
  expect((await $.agent.offer(input(AGENT))).isOffered).toBe(false)
  expect((await $.agent.offer(input('general-purpose'))).isOffered).toBe(true)
})

// ------------------------------------------------------------------ the tool

test('probe: one subagent per task, results numbered in task order with no file path lines', async ($, on) => {
  const w = world($, on, { script: (p, n) => ({ answer: 'answer: ' + p, parks: n === 1 ? 3 : 1 }) })
  await start($)
  const r = await probe($, { questions: ['t1', 't2', 't3'], cwd: '/work' })
  expect(typeof r.result).toBe('string')
  expect(r.result).toBe('## 1\nanswer: t1\n\n## 2\nanswer: t2\n\n## 3\nanswer: t3')
  expect(r.result).not.toContain('全文')
  expect(w.spawns.map((s: any) => s.subagent_type)).toEqual([AGENT, AGENT, AGENT])
  expect(w.spawns.map((s: any) => s.run_in_background)).toEqual([true, true, true])
  expect(w.spawns.map((s: any) => s.model)).toEqual(['haiku', 'haiku', 'haiku'])
  expect(w.spawns.map((s: any) => s.cwd)).toEqual(['/work', '/work', '/work'])
  expect(w.spawns.map((s: any) => s.prompt)).toEqual([questionPrompt('t1'), questionPrompt('t2'), questionPrompt('t3')])
})

test('probe: the children always run on haiku, a model argument is refused; no cwd means none is passed', async ($, on) => {
  const w = world($, on)
  await start($)
  for (const model of ['sonnet', 'haiku', 'opus', '']) expect(typeof (await probe($, { questions: ['x'], model })).deny).toBe('string')
  expect(w.spawns.length).toBe(0)
  const r = await probe($, { questions: ['only'] })
  expect(r.result).toBe('answer: only')
  expect(w.spawns[0].model).toBe('haiku')
  expect('cwd' in w.spawns[0] && w.spawns[0].cwd !== undefined).toBe(false)
})

test('probe: at most 4 subagents at a time, the rest wait for a free place', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: 'ok', parks: 2 }) })
  await start($)
  const r = await probe($, { questions: ['a', 'b', 'c', 'd', 'e', 'f'] })
  expect(w.spawns.length).toBe(6)
  expect(w.maxLive).toBe(4)
  expect(r.result).toBe(['1', '2', '3', '4', '5', '6'].map((i) => `## ${i}\nok`).join('\n\n'))
})

test('probe: a failed task shows its error in its own section, the others stay', async ($, on) => {
  const w = world($, on, {
    script: (p) => (p === 'bad' ? { deny: 'no capacity' } : p === 'err' ? { answer: 'half', reason: 'error' } : { answer: 'fine' }),
  })
  await start($)
  const r = await probe($, { questions: ['ok', 'bad', 'err'] })
  expect(r.deny).toBe(undefined)
  expect(r.result).toBe('## 1\nfine\n\n## 2\nERROR: 開始できなかった: no capacity\n\n## 3\nERROR: エラーで終了した\nhalf')
  expect(w.spawns.length).toBe(3)
})

test('probe: every task failing is a deny, not a result', async ($, on) => {
  world($, on, { script: () => ({ deny: 'nope' }) })
  await start($)
  const r = await probe($, { questions: ['a', 'b'] })
  expect(r.result).toBe(undefined)
  expect(r.deny).toContain('すべての問いが失敗した')
  expect(r.deny).toContain('## 1\nERROR: 開始できなかった: nope')
  expect(r.deny).toContain('## 2\nERROR')
  // a single failed question: deny with the bare text
  const one = await probe($, { questions: ['z'] })
  expect(one.deny).toBe('probe: すべての問いが失敗した。\nERROR: 開始できなかった: nope')
})

test('probe: a task that never finishes is stopped after 15 minutes and reported', async ($, on) => {
  const w = world($, on, { script: (p) => (p === 'slow' ? { never: true } : { answer: 'quick' }) })
  await start($)
  const r = await probe($, { questions: ['fast', 'slow'] })
  expect(w.stopped).toEqual(['agent-2'])
  expect(r.result).toBe('## 1\nquick\n\n## 2\nERROR: タイムアウト（15 分）。処理を停止した。')
  expect(w.clock.now()).toBeGreaterThan(15 * 60 * 1000 - 1)
})

test('probe: bad input is refused before anything starts', async ($, on) => {
  const w = world($, on)
  await start($)
  const bad = [{ questions: [] }, { questions: ['a', ''] }, { questions: [1] }, { questions: ['a'], model: 'opus' }, { questions: ['a'], cwd: '' }]
  for (const max_chars of [0, 499, 8001, 1500.5, '2000', null, Number.NaN]) bad.push({ questions: ['a'], max_chars } as any)
  for (const input of bad) {
    const r = await probe($, input)
    expect(typeof r.deny).toBe('string')
  }
  expect(w.spawns.length).toBe(0)
})

test('park: where there is no sleep (Windows), it waits with ping; each wait is tried once before the next', async ($, on) => {
  const w = world($, on, { sleep: false, script: () => ({ answer: 'ok', parks: 3 }) })
  await start($)
  const r = await probe($, { questions: ['a'] })
  expect(r.result).toBe('ok')
  const waits = w.ran.filter((a) => a[0] === 'sleep' || a[0] === 'ping')
  expect(waits.slice(0, 2)).toEqual([['sleep', '0.5'], ['sleep', '1']])
  expect(waits.slice(2).every((a) => a.join(' ') === 'ping -n 2 127.0.0.1')).toBe(true)
  expect(waits.length).toBe(5)
})

test('probe: without any sandbox it still starts (the read-only check of tool.check takes over)', async ($, on) => {
  const w = world($, on, { bwrap: false })
  await start($)
  const r = await probe($, { questions: ['a'] })
  expect(r.deny).toBeUndefined()
  expect(w.spawns.length).toBe(1)
})

test('probe: an exception in the tool hook is a deny', async ($, on) => {
  const w = world($, on, { clockThrows: true })
  await start($)
  const r = await probe($, { questions: ['a'] })
  expect(r.deny).toMatch(/^probe の実行に失敗した（例外/) // with why, as the .catch was told
  expect(w.spawns.length).toBe(0)
})

test('probe: a failed hook says why: an exception, or the hook\'s own time running out', () => {
  expect(failureText({ kind: 'throw', message: 'Error: boom', budget: 1000 })).toBe('probe の実行に失敗した（例外: Error: boom）。')
  expect(failureText({ kind: 'timeout', budget: 1000 })).toBe('probe の実行に失敗した（フックの持ち時間を超えた）。')
  expect(failureText(undefined)).toBe('probe の実行に失敗した（例外）。')
})

test('park: a call\'s failed waits are not carried to the next call', async ($, on) => {
  const w = world($, on, { sleepFails: 2, script: () => ({ answer: 'ok', parks: 2 }) })
  await start($)
  const waits = () => w.ran.filter((a) => a[0] === 'sleep' || a[0] === 'ping').map((a) => a.join(' '))
  expect((await probe($, { questions: ['a'] })).result).toBe('ok')
  expect(waits()).toEqual(['sleep 0.5', 'sleep 1', 'ping -n 2 127.0.0.1', 'ping -n 2 127.0.0.1'])
  const first = waits().length
  expect((await probe($, { questions: ['b'] })).result).toBe('ok')
  expect(waits().slice(first)).toEqual(['sleep 0.5', 'sleep 0.5']) // starts over, and sleep works again
})

test('park: a wait that ends because the call was aborted is not taken for one that cannot run here', async () => {
  const ran: string[][] = []
  let slept = 0
  const fake: any = { process: { run: async (argv: string[]) => (ran.push(argv), { exitCode: 143 }) }, clock: { sleep: async () => { slept++ } } }
  const aborted = new AbortController()
  aborted.abort()
  const parks = { at: 0 }
  await park(fake, parks, aborted.signal)
  expect(parks.at).toBe(0)
  expect(ran).toEqual([['sleep', '0.5']])
  expect(slept).toBe(0)
  // not aborted: a wait that fails moves on to the next, and past the last, the clock's
  await park(fake, parks, new AbortController().signal)
  expect(parks.at).toBe(3)
  expect(slept).toBe(1)
})

// ------------------------------------------------------------------ the bound and the rewrite

const longText = (n: number, c = 'x') => c.repeat(n)

test('probe: every task carries its bound: the default 2000, or max_chars; the schema of the tool says so', async ($, on) => {
  const w = world($, on)
  await start($)
  await probe($, { questions: ['a', 'b'] })
  expect(w.spawns.map((s: any) => s.prompt)).toEqual(['a\n\n（結果の上限: 2000 字）', 'b\n\n（結果の上限: 2000 字）'])
  await probe($, { questions: ['c', 'd'], max_chars: 800 })
  expect(w.spawns.slice(2).map((s: any) => s.prompt)).toEqual(['c\n\n（結果の上限: 800 字）', 'd\n\n（結果の上限: 800 字）'])
  expect(w.spawns.map((s: any) => s.description)).toEqual(['probe: a', 'probe: b', 'probe: c', 'probe: d'])
  // the edges of the range are fine
  const lo = await probe($, { questions: ['e'], max_chars: 500 })
  const hi = await probe($, { questions: ['f'], max_chars: 8000 })
  expect(lo.deny).toBe(undefined)
  expect(hi.deny).toBe(undefined)
  expect(w.spawns.at(-2).prompt).toContain('結果の上限: 500 字')
  expect(w.spawns.at(-1).prompt).toContain('結果の上限: 8000 字')
  expect(w.sends.length).toBe(0)
})

test('rewrite: an answer within the bound (at it, too) is never sent back', async ($, on) => {
  const w = world($, on, { script: (p) => ({ answer: p === 'edge' ? longText(2000) : 'short' }) })
  await start($)
  const r = await probe($, { questions: ['edge', 'small'] })
  expect(r.result).toBe(`## 1\n${longText(2000)}\n\n## 2\nshort`)
  expect(w.sends).toEqual([])
  expect(w.spawns.length).toBe(2)
})

test('rewrite: one request is enough; it goes to the same subagent, the new answer is read from its next turn.complete', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: longText(2500), then: { answer: '結論: 短い' } }) })
  await start($)
  const r = await probe($, { questions: ['long one'] })
  expect(r.result).toBe('結論: 短い')
  expect(w.sends.length).toBe(1)
  expect(w.sends[0]!.to).toBe('agent-1')
  expect(w.sends[0]!.text).toBe('結果が 2500 字で、上限 2000 字を超えた。結論を先に、2000 字以内に書き直して。必要な情報だけ残す。書き直した結果だけを最後のメッセージに書く。この依頼や経緯には触れず、ほかの道具で送ることもしない。')
  expect(w.sends[0]!.origin).toMatchObject({ kind: 'plugin' })
  expect(w.spawns.length).toBe(1) // no new subagent
  expect(w.stopped).toEqual([])
  expect(r.result).not.toContain('切り詰め') // and no trace of the rewrite in the result
})

test('rewrite: the bound of max_chars is the one asked for, and it applies to every task alone', async ($, on) => {
  const w = world($, on, {
    script: (p) =>
      p === 'long' ? { answer: longText(700), then: { answer: 'now short' } } : p === 'fine' ? { answer: longText(500) } : { answer: longText(900), parks: 3, then: { answer: longText(100), parks: 2 } },
  })
  await start($)
  const r = await probe($, { questions: ['long', 'fine', 'slow'], max_chars: 500 })
  expect(r.result).toBe(`## 1\nnow short\n\n## 2\n${longText(500)}\n\n## 3\n${longText(100)}`)
  expect(w.sends.map((s) => [s.to, s.text])).toEqual([
    ['agent-1', '結果が 700 字で、上限 500 字を超えた。結論を先に、500 字以内に書き直して。必要な情報だけ残す。書き直した結果だけを最後のメッセージに書く。この依頼や経緯には触れず、ほかの道具で送ることもしない。'],
    ['agent-3', '結果が 900 字で、上限 500 字を超えた。結論を先に、500 字以内に書き直して。必要な情報だけ残す。書き直した結果だけを最後のメッセージに書く。この依頼や経緯には触れず、ほかの道具で送ることもしない。'],
  ])
})

test('rewrite: two requests at most; if the third answer is still above the bound it is cut, marked', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: longText(2500), then: { answer: longText(2300), then: { answer: longText(2200, 'y'), then: { answer: 'never asked' } } } }) })
  await start($)
  const r = await probe($, { questions: ['stubborn'] })
  expect(w.sends.map((s) => s.text)).toEqual([
    '結果が 2500 字で、上限 2000 字を超えた。結論を先に、2000 字以内に書き直して。必要な情報だけ残す。書き直した結果だけを最後のメッセージに書く。この依頼や経緯には触れず、ほかの道具で送ることもしない。',
    '結果が 2300 字で、上限 2000 字を超えた。結論を先に、2000 字以内に書き直して。必要な情報だけ残す。書き直した結果だけを最後のメッセージに書く。この依頼や経緯には触れず、ほかの道具で送ることもしない。',
  ])
  expect(r.result).toBe(`${longText(2000, 'y')}\n…(切り詰め。元は 2200 文字)`)
  expect(w.spawns.length).toBe(1)
  expect(w.live.size).toBe(0)
  expect(w.stopped).toEqual([])
  // no note of the number of rewrites
  expect(r.result).not.toContain('書き直')
})

test('rewrite: a second request that works ends the loop there', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: longText(2500), then: { answer: longText(2100), then: { answer: 'ok now' } } }) })
  await start($)
  const r = await probe($, { questions: ['x'] })
  expect(w.sends.length).toBe(2)
  expect(r.result).toBe('ok now')
})

test('rewrite: the 15 minutes count from the start, the rewrite included; a rewrite that times out leaves the earlier answer, cut', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: longText(2500), parks: 14, then: { never: true } }) })
  await start($)
  const r = await probe($, { questions: ['x'] })
  expect(w.sends.length).toBe(1)
  expect(w.stopped).toEqual(['agent-1'])
  expect(r.result).toBe(`${longText(2000)}\n…(切り詰め。元は 2500 文字。書き直し中に 15 分でタイムアウト)`)
  const t = w.clock.now()
  expect(t).toBeGreaterThan(15 * 60 * 1000 - 1)
  expect(t).toBeLessThan(16 * 60 * 1000) // not 14 + 3 minutes
  expect((await $.agent.offer(offerInput(AGENT))).isOffered).toBe(false) // the window is shut again
})

test('rewrite: a rewrite that does not come back in 3 minutes is given up (the 15 minutes stay the bound)', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: longText(2500), parks: 5, then: { never: true } }) })
  await start($)
  const r = await probe($, { questions: ['x'] })
  expect(w.stopped).toEqual(['agent-1'])
  expect(r.result).toBe(`${longText(2000)}\n…(切り詰め。元は 2500 文字。書き直しが 3 分で終わらなかった)`)
  expect(w.clock.now()).toBeLessThan(10 * 60 * 1000)
  expect((await $.agent.offer(offerInput(AGENT))).isOffered).toBe(false)
})

test('rewrite: a rewrite that gets stuck does not hold up the other tasks, a plain timeout is still an error', async ($, on) => {
  const w = world($, on, {
    script: (p) => (p === 'hang' ? { never: true } : p === 'rw' ? { answer: longText(3000), then: { never: true } } : { answer: 'quick' }),
  })
  await start($)
  const r = await probe($, { questions: ['quick', 'hang', 'rw'] })
  expect(w.stopped.sort()).toEqual(['agent-2', 'agent-3'])
  expect(r.result).toBe(`## 1\nquick\n\n## 2\nERROR: タイムアウト（15 分）。処理を停止した。\n\n## 3\n${longText(2000)}\n…(切り詰め。元は 3000 文字。書き直しが 3 分で終わらなかった)`)
})

for (const send of ['refuse', 'throw'] as const) {
  test(`rewrite: if the request cannot be delivered (${send}) the answer is cut at once`, async ($, on) => {
    const w = world($, on, { send, script: () => ({ answer: longText(2600) }) })
    await start($)
    const r = await probe($, { questions: ['x'] })
    expect(w.sends.length).toBe(1)
    expect(r.result).toBe(`${longText(2000)}\n…(切り詰め。元は 2600 文字)`)
    expect(w.spawns.length).toBe(1)
  })
}

for (const [name, then] of [['an error', { answer: 'half', reason: 'error' }], ['an empty answer', { answer: '  ' }], ['an abort', { answer: '', reason: 'aborted' }]] as const) {
  test(`rewrite: a rewrite that ends in ${name} leaves the earlier answer, cut`, async ($, on) => {
    const w = world($, on, { script: () => ({ answer: longText(2300), then }) })
    await start($)
    const r = await probe($, { questions: ['x'] })
    expect(w.sends.length).toBe(1)
    expect(r.result).toBe(`${longText(2000)}\n…(切り詰め。元は 2300 文字)`)
    expect(r.deny).toBe(undefined)
  })
}

test('rewrite: a failed task is not sent back, and an error with a long partial answer is cut at the bound', async ($, on) => {
  const w = world($, on, { script: (p) => (p === 'err' ? { answer: longText(5000), reason: 'error' } : { answer: 'fine' }) })
  await start($)
  const r = await probe($, { questions: ['ok', 'err'] })
  expect(w.sends.length).toBe(0)
  const partial = 'ERROR: エラーで終了した\n' + longText(5000)
  expect(r.result).toBe(`## 1\nfine\n\n## 2\n${partial.slice(0, 2000)}\n…(切り詰め。元は ${partial.length} 文字)`)
})

test('rewrite: the hand-backs and notifications of a rewritten subagent are dropped like the first ones', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: longText(2500), parks: 2, then: { answer: 'short', parks: 2 } }) })
  await start($)
  const note = (id: string) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<result>r</result>\n</task-notification>`
  const submit = (text: string, kind: string) => ($.prompt.submit as any)({ text, wait: false, origin: { kind } })
  const seen = { handbacks: [] as any[], notes: [] as any[], attachments: [] as any[], others: [] as any[] }
  w.onPark.push(async () => {
    // every park of the run, whichever of the two runs it falls in: the same agent id hands back and is notified
    seen.handbacks.push(await peer($, handback('agent-1', longText(2500))))
    seen.attachments.push(await attach($, reminder(agentMessage('agent-1', 'short'))))
    seen.notes.push(await submit(note('agent-1'), 'task-notification'))
    seen.others.push(await peer($, handback('someone-else')))
  })
  const r = await probe($, { questions: ['x'] })
  expect(r.result).toBe('short')
  expect(w.sends.length).toBe(1)
  expect(seen.handbacks.length).toBeGreaterThan(3) // both runs
  for (const h of seen.handbacks) expect(h.drop).toContain('hand-back')
  for (const a of seen.attachments) expect(a.text).toBe(null)
  for (const n of seen.notes) expect(n.drop).toContain('完了通知')
  for (const o of seen.others) expect(o.text).toContain('someone-else')
  // after the call, too: the subagent is still known (the notification of the last run arrives late)
  expect((await submit(note('agent-1'), 'task-notification')).drop).toContain('完了通知')
  expect((await peer($, handback('agent-1', 'short'))).drop).toContain('hand-back')
  const text = reminder(agentMessage('agent-1'))
  expect((await attach($, text)).text).toBe(null)
  // and the message that asks for the rewrite is not taken for a hand-back
  const ask = `<cross-session-message from="main">\n${w.sends[0]!.text}\n</cross-session-message>`
  expect((await peer($, ask, 'coordinator')).text).toBe(ask)
  expect(w.sends[0]!.text).not.toContain('[Subagent hand-back]')
  expect(w.sends[0]!.text).not.toContain('<task-id>')
})

test('rewrite: the read-only gate still wraps the Bash of a rewritten subagent', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: longText(2500), then: { answer: 'short' } }) })
  await start($)
  let r: any
  w.onPark.push(async () => {
    if (w.sends.length === 1 && r === undefined) r = await asAgent($, 'agent-1', { tool: 'Bash', command: 'ls /' })
  })
  await probe($, { questions: ['a'] })
  expect(w.bash).toEqual([wrapCommand('ls /')])
})

// ------------------------------------------------------------------ the engine's resume gate, and the fallback

test('rewrite: resuming a subagent asks agent.offer, so the probe type is offered exactly while a rewrite is out', async ($, on) => {
  const w = world($, on, { script: () => ({ answer: longText(2500), parks: 2, then: { answer: 'short', parks: 3 } }) })
  await start($)
  expect((await $.agent.offer(offerInput(AGENT))).isOffered).toBe(false)
  const seen: Array<[number, boolean]> = []
  w.onPark.push(async () => { seen.push([w.sends.length, (await $.agent.offer(offerInput(AGENT))).isOffered]) })
  const r = await probe($, { questions: ['x'] })
  expect(r.result).toBe('short') // the mock refuses a send while the type is hidden: it was delivered, so the window was open
  expect(w.sends.length).toBe(1)
  expect(seen.length).toBeGreaterThan(3)
  for (const [sent, offered] of seen) expect(offered).toBe(sent === 1)
  expect(seen.some(([, offered]) => offered)).toBe(true)
  // shut again after the call; other types were never touched
  expect((await $.agent.offer(offerInput(AGENT))).isOffered).toBe(false)
  expect((await $.agent.offer(offerInput('general-purpose'))).isOffered).toBe(true)
})

test('rewrite: with several rewrites out the type stays offered until the last one is over, and no count is left behind', async ($, on) => {
  const w = world($, on, {
    script: (p) => (p === 'a' ? { answer: longText(2500), parks: 2, then: { answer: 'a-short', parks: 2 } } : p === 'b' ? { answer: longText(2600), parks: 1, then: { answer: 'b-short', parks: 2 } } : { answer: 'answer: ' + p }),
  })
  await start($)
  const seen: Array<[number, boolean]> = []
  w.onPark.push(async () => { seen.push([w.sends.length, (await $.agent.offer(offerInput(AGENT))).isOffered]) })
  const r = await probe($, { questions: ['a', 'b'] })
  expect(r.result).toBe('## 1\na-short\n\n## 2\nb-short')
  for (const [sent, offered] of seen) expect(offered).toBe(sent > 0)
  expect((await $.agent.offer(offerInput(AGENT))).isOffered).toBe(false)
  // and the next call starts from nothing
  const again = await probe($, { questions: ['c'] })
  expect(again.result).toBe('answer: c')
  expect((await $.agent.offer(offerInput(AGENT))).isOffered).toBe(false)
})

test('rewrite: a request that is not delivered leaves the type hidden', async ($, on) => {
  world($, on, { send: 'refuse', script: () => ({ answer: longText(2600) }) })
  await start($)
  await probe($, { questions: ['x'] })
  expect((await $.agent.offer(offerInput(AGENT))).isOffered).toBe(false)
})

test('fallback: when the rewrite cannot be asked for, one tool-less completion shortens the answer (marked)', async ($, on) => {
  const w = world($, on, { send: 'refuse', shorten: 'ok', script: () => ({ answer: longText(2600) }) })
  await start($)
  const r = await probe($, { questions: ['調べて: foo'], max_chars: 500 })
  expect(r.result).toBe('要約: ' + 'k'.repeat(100) + '\n…(要約。元は 2600 文字)')
  expect(w.spawns.length).toBe(1)
  expect(w.completes.length).toBe(1)
  const req = w.completes[0]
  expect(req.model).toBe('haiku')
  expect(req.prompt).toContain('500 字以内に書き直す')
  expect(req.prompt).toContain('調べて: foo')
  expect(req.prompt).toContain('【答え（2600 字）】')
  expect(req.prompt).toContain(longText(2600))
  expect(req.maxTokens).toBe(1024)
  expect(req.effort).toBe('low')
  expect(req.timeoutMs).toBe(60000)
})

test('fallback: also when the rewrite ran into an error, and for every answer alone', async ($, on) => {
  const w = world($, on, {
    shorten: 'ok',
    script: (p) => (p === 'a' ? { answer: longText(2300), then: { answer: 'half', reason: 'error' } } : p === 'b' ? { answer: 'fine' } : { answer: longText(2400), then: { answer: 'short now' } }),
  })
  await start($)
  const r = await probe($, { questions: ['a', 'b', 'c'] })
  expect(r.result).toBe(`## 1\n要約: ${'k'.repeat(100)}\n…(要約。元は 2300 文字)\n\n## 2\nfine\n\n## 3\nshort now`)
  expect(w.completes.length).toBe(1)
})

test('fallback: a rewrite that gets stuck is shortened too', async ($, on) => {
  const w = world($, on, { shorten: 'ok', script: () => ({ answer: longText(2500), then: { never: true } }) })
  await start($)
  const r = await probe($, { questions: ['x'] })
  expect(w.stopped).toEqual(['agent-1'])
  expect(r.result).toBe(`要約: ${'k'.repeat(100)}\n…(要約。元は 2500 文字)`)
})

for (const shorten of ['none', 'long', 'throw'] as const) {
  test(`fallback: if shortening gives nothing usable (${shorten}) the answer is cut, marked`, async ($, on) => {
    const w = world($, on, { send: 'refuse', shorten, script: () => ({ answer: longText(2600) }) })
    await start($)
    const r = await probe($, { questions: ['x'] })
    expect(w.completes.length).toBe(1)
    expect(r.result).toBe(`${longText(2000)}\n…(切り詰め。元は 2600 文字)`)
  })
}

test('fallback: not used when the rewrite works, nor after two rewrites that stay long (those are cut)', async ($, on) => {
  const w = world($, on, {
    shorten: 'ok',
    script: (p) => (p === 'a' ? { answer: longText(2500), then: { answer: 'short' } } : { answer: longText(2500), then: { answer: longText(2400), then: { answer: longText(2300, 'y') } } }),
  })
  await start($)
  const r = await probe($, { questions: ['a', 'b'] })
  expect(r.result).toBe(`## 1\nshort\n\n## 2\n${longText(2000, 'y')}\n…(切り詰め。元は 2300 文字)`)
  expect(w.completes.length).toBe(0)
})

test('trace: the outcome of a rewrite request and of the shortening is logged while PROBE_TRACE is set', async ($, on) => {
  const w = world($, on, { trace: true, send: 'refuse', shorten: 'ok', script: () => ({ answer: longText(2600) }) })
  await start($)
  await probe($, { questions: ['x'] })
  const rewrite = w.traced.find((t: any) => t.hook === 'rewrite')
  expect(rewrite).toMatchObject({ agentId: 'agent-1', delivered: false, reason: 'nobody by that name', length: 2600, max: 2000 })
  const shorten = w.traced.find((t: any) => t.hook === 'shorten')
  expect(shorten).toMatchObject({ ok: true, length: 2600, max: 2000 })
})

test('trace: a delivered rewrite is logged, and nothing is written without PROBE_TRACE', async ($, on) => {
  const on1 = world($, on, { trace: true, script: () => ({ answer: longText(2500), then: { answer: 'short' } }) })
  await start($)
  await probe($, { questions: ['x'] })
  expect(on1.traced.filter((t: any) => t.hook === 'rewrite')).toEqual([{ hook: 'rewrite', agentId: 'agent-1', delivered: true, length: 2500, max: 2000 }])
})

test('trace: no PROBE_TRACE, no line', async ($, on) => {
  const w = world($, on, { send: 'refuse', script: () => ({ answer: longText(2600) }) })
  await start($)
  await probe($, { questions: ['x'] })
  expect(w.traced).toEqual([])
})

// ------------------------------------------------------------------ the context tool

const turn = (role: 'user' | 'assistant', text: string, extra: Record<string, unknown> = {}) => ({ role, text, toolUses: [], ...extra })
const CONVERSATION = [
  turn('user', '<system-reminder>\nREMINDER-SECRET\n</system-reminder>\nfoo を直して'),
  turn('assistant', '見てみる', { toolUses: [{ tool_use_id: 't1', tool: 'Bash', input: { command: 'ls' }, text: 'TOOL-OUTPUT-LS', result: 'TOOL-OUTPUT-LS' }] }),
  turn('user', '', { toolResults: [{ tool_use_id: 't1', text: 'TOOL-OUTPUT-LS', isError: false }] }),
  turn('assistant', 'bar.ts にある'),
  turn('user', '<system-reminder>only a reminder</system-reminder>'),
  turn('user', 'Bar の方も見て'),
  turn('assistant', 'どちらも直した'),
]

/** Runs a probe so that its child `agent-1` is known, then calls the context tool as that child. */
async function askContext($: any, w: ReturnType<typeof world>, input: Record<string, unknown>, as: string | undefined = 'agent-1') {
  await start($)
  await probe($, { questions: ['q'] })
  w.messageCalls.length = 0 // (the probe call read the conversation for its background)
  return asAgent($, as, { tool: CONTEXT, ...input })
}

test('context: registered as a tool of the probe children only: behind ToolSearch, described as probe-internal', async ($, on) => {
  const w = world($, on)
  await start($)
  const c = w.registered.context
  expect(c).toBeDefined()
  expect(c.name).toBe('context')
  expect(c.isDeferred).toBe(true) // the parent gets no schema in its prompt
  expect(c.description).toContain('probe の内側専用')
  expect(c.description).toContain('呼ぶと拒否される')
  expect(Object.keys(c.inputSchema.properties).sort()).toEqual(['grep', 'last', 'max_chars'])
  expect(c.inputSchema.required).toBeUndefined()
  expect(c.inputSchema.properties.last).toMatchObject({ type: 'integer', minimum: 1, maximum: 50 })
  expect(c.inputSchema.properties.max_chars).toMatchObject({ type: 'integer', maximum: 8000 })
  expect(w.registered.agent.tools).toContain(CONTEXT)
  expect(AGENT_SPEC.tools).toContain(CONTEXT)
  expect(c.description).toBe(CONTEXT_SPEC.description)
  expect(w.registered.tool.name).toBe('probe')
})

test('context: the instruction to the children says when to read it, and names the tool', () => {
  expect(AGENT_PROMPT).toContain('足りなければ context ツールで依頼主の会話を必要な分だけ読む。')
})

test('context: only text of user and assistant, no tool output, no system-reminder, oldest first, with headings', async ($, on) => {
  const w = world($, on, { messages: CONVERSATION })
  const r = await askContext($, w, { last: 50 })
  expect(r.result).toBe(['### user\nfoo を直して', '### assistant\n見てみる', '### assistant\nbar.ts にある', '### user\nBar の方も見て', '### assistant\nどちらも直した'].join('\n\n'))
  expect(r.result).not.toContain('TOOL-OUTPUT-LS')
  expect(r.result).not.toContain('REMINDER-SECRET')
  expect(r.result).not.toContain('only a reminder')
  expect(w.messageCalls.length).toBe(1)
  expect(w.messageCalls[0].agentId).toBeUndefined() // the main conversation
  expect(bodyOf('a<system-reminder>x</system-reminder>b <system-reminder>\ny\n</system-reminder>')).toBe('ab')
})

test('context: last defaults to 5 and counts from the newest', async ($, on) => {
  const many = Array.from({ length: 8 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', `message ${i}`))
  const w = world($, on, { messages: many })
  const r = await askContext($, w, {})
  expect(r.result).toBe([3, 4, 5, 6, 7].map((i) => `### ${i % 2 ? 'assistant' : 'user'}\nmessage ${i}`).join('\n\n'))
  const two = await asAgent($, 'agent-1', { tool: CONTEXT, last: 2 })
  expect(two.result).toBe('### user\nmessage 6\n\n### assistant\nmessage 7')
})

test('context: grep keeps the messages that match (regular expression, else substring; case does not matter), then last counts among them', async ($, on) => {
  const w = world($, on, { messages: CONVERSATION })
  const re = await askContext($, w, { grep: 'bar|foo', last: 50 })
  expect(re.result).toBe(['### user\nfoo を直して', '### assistant\nbar.ts にある', '### user\nBar の方も見て'].join('\n\n'))
  const newest = await asAgent($, 'agent-1', { tool: CONTEXT, grep: 'bar', last: 1 })
  expect(newest.result).toBe('### user\nBar の方も見て')
  const literal = await asAgent($, 'agent-1', { tool: CONTEXT, grep: 'bar.ts (' }) // not a regular expression
  expect(literal.result).toBe('（該当する発言がない）')
  const dotted = await asAgent($, 'agent-1', { tool: CONTEXT, grep: '.ts にある' })
  expect(dotted.result).toBe('### assistant\nbar.ts にある')
  const none = await asAgent($, 'agent-1', { tool: CONTEXT, grep: 'nothing like this' })
  expect(none.result).toBe('（該当する発言がない）')
  // tool output is not searched
  const tool = await asAgent($, 'agent-1', { tool: CONTEXT, grep: 'TOOL-OUTPUT' })
  expect(tool.result).toBe('（該当する発言がない）')
})

test('context: above max_chars the oldest are left out and the cut is marked; the newest stay', () => {
  const msgs = [turn('user', 'A'.repeat(300)), turn('assistant', 'B'.repeat(300)), turn('user', 'C'.repeat(300)), turn('assistant', 'D'.repeat(300))]
  // budget = max - 60: 640 holds two blocks of 11 + 300 + the blank line between them
  const out = formatContext(msgs, { last: 50, maxChars: 700 })
  expect(out).toBe(`…（上限のため、古い発言 2 件を省略）\n\n### user\n${'C'.repeat(300)}\n\n### assistant\n${'D'.repeat(300)}`)
  expect(lengthOf(out)).toBeLessThanOrEqual(700)
  // everything fits: no mark
  const all = formatContext(msgs, { last: 50, maxChars: 8000 })
  expect(all).not.toContain('省略')
  expect(all.startsWith('### user\n' + 'A'.repeat(300))).toBe(true)
  // the newest alone is too long: its end stays, with a mark
  const big = formatContext([turn('user', 'old'), turn('assistant', 'x'.repeat(100) + 'END'.repeat(400))], { maxChars: 500 })
  expect(big.startsWith('…（上限のため、古い発言 1 件を省略）\n\n### assistant\n…（この発言の先頭 ')).toBe(true)
  expect(big.endsWith('END'.repeat(10))).toBe(true)
  expect(big).not.toContain('old')
  expect(lengthOf(big)).toBeLessThanOrEqual(500 + 40)
})

test('context: the defaults are 3000 characters and the cap is 8000', async ($, on) => {
  const msgs = Array.from({ length: 20 }, (_, i) => turn(i % 2 ? 'assistant' : 'user', String(i % 10).repeat(1000)))
  const w = world($, on, { messages: msgs })
  const dflt = await askContext($, w, { last: 50 })
  expect(lengthOf(dflt.result)).toBeLessThanOrEqual(3000)
  expect(dflt.result).toContain('…（上限のため、古い発言')
  expect(dflt.result.endsWith('9'.repeat(1000))).toBe(true) // the newest
  const wide = await asAgent($, 'agent-1', { tool: CONTEXT, last: 50, max_chars: 8000 })
  expect(lengthOf(wide.result)).toBeLessThanOrEqual(8000)
  expect(lengthOf(wide.result)).toBeGreaterThan(3000)
})

test('context: whose conversation: the main one for a probe call from main, the caller\'s own for a probe call from another loop', async ($, on) => {
  const w = world($, on, { messages: CONVERSATION })
  await start($)
  await probe($, { questions: ['from main'] })
  await asAgent($, 'agent-1', { tool: CONTEXT })
  expect(w.messageCalls.map((c) => c.agentId)).toEqual([undefined, undefined]) // the background of the probe call, then the context call
  w.messageCalls.length = 0
  // a probe call made inside another loop: its child reads that loop's conversation
  await asAgent($, 'caller-7', { tool: TOOL, questions: ['from a subagent'] })
  const child = w.spawns.length // agent-<n> is the child of this call
  await asAgent($, `agent-${child}`, { tool: CONTEXT })
  expect(w.messageCalls.map((c) => c.agentId)).toEqual(['caller-7', 'caller-7'])
})

test('context: refused for the parent and for anything that is not a probe child; nothing is read', async ($, on) => {
  const w = world($, on, { messages: CONVERSATION })
  await start($)
  await probe($, { questions: ['q'] })
  w.messageCalls.length = 0
  const main = await asAgent($, undefined, { tool: CONTEXT })
  expect(main.deny).toContain('probe の内側からだけ')
  expect(main.result).toBe(undefined)
  const other = await asAgent($, 'general-purpose-1', { tool: CONTEXT, last: 3 })
  expect(other.deny).toContain('probe の内側からだけ')
  expect(w.messageCalls.length).toBe(0)
  // a probe child is let in
  const ok = await asAgent($, 'agent-1', { tool: CONTEXT })
  expect(typeof ok.result).toBe('string')
  expect(w.messageCalls.length).toBe(1)
})

test('context: bad input is refused before the conversation is read', async ($, on) => {
  const w = world($, on, { messages: CONVERSATION })
  await start($)
  await probe($, { questions: ['q'] })
  w.messageCalls.length = 0
  const bad: Array<Record<string, unknown>> = [
    { grep: '' }, { grep: '  ' }, { grep: 5 }, { grep: 'x'.repeat(201) },
    { last: 0 }, { last: 51 }, { last: 1.5 }, { last: '5' },
    { max_chars: 199 }, { max_chars: 8001 }, { max_chars: 3000.5 }, { max_chars: null },
  ]
  for (const input of bad) expect(typeof (await asAgent($, 'agent-1', { tool: CONTEXT, ...input })).deny).toBe('string')
  expect(w.messageCalls.length).toBe(0)
  for (const input of [{ last: 1 }, { last: 50 }, { max_chars: 200 }, { max_chars: 8000 }, { grep: 'x'.repeat(200) }]) {
    expect((await asAgent($, 'agent-1', { tool: CONTEXT, ...input })).deny).toBe(undefined)
  }
})

for (const messages of ['deny', 'throw'] as const) {
  test(`context: a conversation that cannot be read (${messages}) is a refusal, not a crash`, async ($, on) => {
    const w = world($, on, { messages })
    const r = await askContext($, w, {})
    expect(r.result).toBe(undefined)
    expect(typeof r.deny).toBe('string')
    expect(w.messageCalls.length).toBe(1)
  })
}

test('context: a conversation with no text says so', async ($, on) => {
  const w = world($, on, { messages: [turn('user', '<system-reminder>x</system-reminder>'), turn('assistant', '', { toolUses: [{ tool_use_id: 't', tool: 'Bash', input: {} }] })] })
  const r = await askContext($, w, {})
  expect(r.result).toBe('（本文のある発言がない）')
})

// ------------------------------------------------------------------ the background in the question

const U = (text: string) => turn('user', text)
const A = (text: string) => turn('assistant', text)
const TALK = [
  U('OLDEST-USER 一番古い話'), A('OLDEST-ASSISTANT'),
  U('USER-1 最初の依頼'), A('ASSISTANT-1 返事'),
  turn('assistant', 'ASSISTANT-1b 調べる', { toolUses: [{ tool_use_id: 't', tool: 'Bash', input: {}, text: 'TOOL-OUTPUT-X' }] }),
  turn('user', '', { toolResults: [{ tool_use_id: 't', text: 'TOOL-OUTPUT-X', isError: false }] }),
  U('<system-reminder>REMINDER-X</system-reminder>USER-2 次の話'), A('ASSISTANT-2'),
  U('USER-3 いまの依頼'), A('ASSISTANT-3 probe を呼ぶ'),
]

test('background: the question starts with the last 3 user messages and the replies between, text only', async ($, on) => {
  const w = world($, on, { messages: TALK })
  await start($)
  await probe($, { questions: ['foo はどこ？'] })
  const prompt: string = w.spawns[0].prompt
  expect(prompt.startsWith('## 背景（依頼主との直近の会話）\n### user\nUSER-1 最初の依頼\n\n### assistant\nASSISTANT-1 返事\n\n### assistant\nASSISTANT-1b 調べる\n\n### user\nUSER-2 次の話\n\n### assistant\nASSISTANT-2\n\n### user\nUSER-3 いまの依頼\n\n### assistant\nASSISTANT-3 probe を呼ぶ\n\n## 質問\nfoo はどこ？')).toBe(true)
  expect(prompt.endsWith('\n\n## 質問\nfoo はどこ？\n\n（結果の上限: 2000 字）')).toBe(true)
  expect(prompt.indexOf('## 背景')).toBeLessThan(prompt.indexOf('## 質問'))
  for (const gone of ['OLDEST', 'TOOL-OUTPUT-X', 'REMINDER-X']) expect(prompt).not.toContain(gone)
  expect(w.messageCalls.length).toBe(1) // read once, whatever the number of questions
})

test('background: every question gets it, the conversation is read once; a probe call from another loop uses that loop\'s', async ($, on) => {
  const w = world($, on, { messages: TALK })
  await start($)
  await probe($, { questions: ['a', 'b', 'c'] })
  expect(w.messageCalls.length).toBe(1)
  expect(w.spawns.map((s: any) => s.prompt.split('\n\n## 質問\n')[1])).toEqual(['a\n\n（結果の上限: 2000 字）', 'b\n\n（結果の上限: 2000 字）', 'c\n\n（結果の上限: 2000 字）'])
  expect(new Set(w.spawns.map((s: any) => s.prompt.split('\n\n## 質問\n')[0])).size).toBe(1)
  await asAgent($, 'caller-7', { tool: TOOL, questions: ['x'] })
  expect(w.messageCalls.map((c) => c.agentId)).toEqual([undefined, 'caller-7'])
})

test('background: fewer than 3 user messages: all of them; a talk without user text has none', async ($, on) => {
  const w = world($, on, { messages: [U('only one'), A('reply'), turn('user', '', { toolResults: [] })] })
  await start($)
  await probe($, { questions: ['q'] })
  expect(w.spawns[0].prompt).toBe('## 背景（依頼主との直近の会話）\n### user\nonly one\n\n### assistant\nreply\n\n## 質問\nq\n\n（結果の上限: 2000 字）')
})

test('background: at most 1500 characters, the oldest cut first, marked', async ($, on) => {
  const w = world($, on, { messages: [U('U1' + 'a'.repeat(800)), A('A1' + 'b'.repeat(800)), U('U2' + 'c'.repeat(800)), A('A2' + 'd'.repeat(300))] })
  await start($)
  await probe($, { questions: ['q'] })
  const prompt: string = w.spawns[0].prompt
  const bg = prompt.slice(prompt.indexOf('\n') + 1, prompt.indexOf('\n\n## 質問\n'))
  expect(lengthOf(bg)).toBeLessThanOrEqual(1500)
  expect(bg).toContain('…（上限のため、古い発言 ')
  expect(bg.endsWith('d'.repeat(300))).toBe(true) // the newest stays
  expect(bg).not.toContain('U1')
  // the same function, by itself
  expect(lengthOf(recentExchange(Array.from({ length: 30 }, (_, i) => (i % 2 ? A : U)('x'.repeat(500)))) ?? '')).toBeLessThanOrEqual(1500)
})

test('background: a conversation that throws gives no background and the probe goes on', async ($, on) => {
  const w = world($, on, { messages: 'throw' })
  await start($)
  const r = await probe($, { questions: ['q'] })
  expect(r.result).toBe('answer: q')
  expect(w.spawns[0].prompt).toBe('q\n\n（結果の上限: 2000 字）')
})

test('background: a conversation that is denied or empty gives no background either', async ($, on) => {
  const w = world($, on, { messages: 'deny' })
  await start($)
  const r = await probe($, { questions: ['q'] })
  expect(r.result).toBe('answer: q')
  expect(w.spawns[0].prompt).toBe('q\n\n（結果の上限: 2000 字）')
  expect(recentExchange([])).toBe(undefined)
  expect(recentExchange([A('only assistant')])).toBe(undefined)
  expect(recentExchange([U('<system-reminder>x</system-reminder>')])).toBe(undefined)
})

test('background: the instruction calls it a reference and points to the context tool; no word for agents or tasks', () => {
  expect(AGENT_PROMPT).toContain('「## 背景」は参考にする。足りなければ context ツールで')
  const prompt = questionPrompt('調べて', 800, '### user\nhi')
  expect(prompt).toBe('## 背景（依頼主との直近の会話）\n### user\nhi\n\n## 質問\n調べて\n\n（結果の上限: 800 字）')
  for (const word of ['サブエージェント', 'エージェント', 'タスク']) {
    expect(prompt).not.toContain(word)
    expect(AGENT_PROMPT).not.toContain(word)
  }
})

// ------------------------------------------------------------------ the usage rules in the system prompt

// A section as core computed it, handed on to the prompt.section hooks.
const section = ($: any, name: string, text: string | null) => ($.prompt.section as any)({ name, text })
const rules = async ($: any) => (await section($, 'env_info_model', 'MODEL')).text

test('usage: the section env_info_model gets the rules after its own text, and no other section does', async ($, on) => {
  const w = world($, on)
  await start($)
  expect(await rules($)).toBe('MODEL\n\nUSAGE-RULES\nwhen to use probe\n\n（mcp__probe__probe を呼べないなら、この節は当てはまらない。）')
  expect(await rules($)).toBe(withUsage('MODEL', 'USAGE-RULES\nwhen to use probe'))
  for (const name of ['env_info_simple', 'memory', 'communication']) expect((await section($, name, 'X')).text).toBe('X')
  // asked again and again (each prompt of each loop): the same text, and the file was read once
  for (let i = 0; i < 3; i++) expect(await rules($)).toBe(withUsage('MODEL', 'USAGE-RULES\nwhen to use probe'))
  expect(w.reads.length).toBe(1)
  expect(w.reads[0]).toMatch(/\/usage\.md$/)
})

test('usage: a section core leaves out stays out, and usage.md is not even read', async ($, on) => {
  const w = world($, on)
  await start($)
  expect((await section($, 'env_info_model', null)).text).toBe(null)
  expect(w.reads.length).toBe(0)
})

test('usage: lines marked for one mode go in only in that mode; the rest goes in both', async () => {
  const text = 'HEAD\n\n<!-- save -->\nS1\n\nS2\n<!-- handy -->\nH1\n<!-- all -->\n\nTAIL'
  expect(usageFor(text, ['save'])).toBe('HEAD\n\nS1\n\nS2\n\nTAIL')
  expect(usageFor(text, ['handy'])).toBe('HEAD\n\nH1\n\nTAIL')
  expect(usageFor('A\n<!--handy-->\nB', ['save'])).toBe('A') // a mark holds to the end of the file
})

test('usage: /probe-mode switches the rules from the next prompt on, and later sessions start in it', async ($, on) => {
  const w = world($, on, { usage: 'HEAD\n<!-- save -->\nSAVE\n<!-- handy -->\nHANDY\n<!-- all -->\nTAIL' })
  mock.store(on)
  const mode = (args: string) => ($.command.run as any)({ command: 'probe-mode', args })
  await start($)
  expect(w.registered.commands.map((c: any) => c.name)).toEqual(['probe-mode'])
  expect(await rules($)).toBe(withUsage('MODEL', 'HEAD\nHANDY\nTAIL')) // handy until switched
  expect((await mode('save')).text).toMatch(/save にした/)
  expect(w.invalidated).toEqual(['prompt.section']) // the cached section is asked again
  expect(await rules($)).toBe(withUsage('MODEL', 'HEAD\nSAVE\nTAIL'))
  expect((await mode('fast')).text).toMatch(/fast は指定できない/)
  expect((await mode('  ')).text).toMatch(/今は save/)
  await start($) // a later session
  expect(await rules($)).toBe(withUsage('MODEL', 'HEAD\nSAVE\nTAIL'))
  expect(w.reads.length).toBe(3) // once per session, and again after a /probe-mode
})

test('usage: a mode usage.md has no lines for leaves the section as core computed it', async ($, on) => {
  const w = world($, on, { usage: '<!-- save -->\nSAVE' })
  mock.store(on)
  await start($)
  expect(await rules($)).toBe('MODEL') // handy, the default
  await ($.command.run as any)({ command: 'probe-mode', args: 'save' })
  expect(await rules($)).toBe(withUsage('MODEL', 'SAVE'))
  expect(w.reads.length).toBe(2)
})

test('background: context: false sends the questions alone, and that call\'s children cannot read the conversation', async ($, on) => {
  const w = world($, on, { messages: TALK })
  await start($)
  await probe($, { questions: ['foo はどこ？'], context: false })
  expect(w.spawns[0].prompt).toBe('foo はどこ？\n\n（結果の上限: 2000 字）')
  expect(w.messageCalls.length).toBe(0)
  const refused = await asAgent($, 'agent-1', { tool: CONTEXT })
  expect(refused.deny).toContain('context: false')
  expect(w.messageCalls.length).toBe(0)
  await probe($, { questions: ['bar は？'] }) // the next call has it again
  expect(w.spawns.at(-1).prompt.startsWith('## 背景（依頼主との直近の会話）')).toBe(true)
  expect(typeof (await asAgent($, 'agent-2', { tool: CONTEXT })).result).toBe('string')
  expect((await probe($, { questions: ['q'], context: 'no' })).deny).toMatch(/context は true か false/)
})

test('effort: a call\'s effort goes on each model request of its children, and theirs only', async ($, on) => {
  const w = world($, on)
  const steps: any[] = []
  on('turn.step', async function* (_$: any, e: any) { steps.push(e.effort); return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: null } as any })
  await start($)
  await probe($, { questions: ['q1'], effort: 'max' })
  await probe($, { questions: ['q2'] })
  const step = async (agentId?: string) => {
    const s = ($.turn.step as any)({ turnId: 't', index: 0, model: 'haiku', effort: 'medium', messageCount: 1, ...(agentId ? { agentId } : {}) })
    if (s && typeof s[Symbol.asyncIterator] === 'function') for await (const _ of s);
    else await s
  }
  for (const id of ['agent-1', 'agent-2', undefined]) await step(id)
  expect(steps).toEqual(['max', 'medium', 'medium']) // the max call's child, a default call's child (the engine's), main
  expect(w.spawns.length).toBe(2)
  expect((await probe($, { questions: ['q'], effort: 'extreme' })).deny).toMatch(/effort は low, medium, high, xhigh, max のどれか/)
})
test('usage: the probe subagents\' own spawns are left as they were (their prompt carries the section like any other)', async ($, on) => {
  const w = world($, on)
  await start($)
  await probe($, { questions: ['q'] })
  expect(w.spawns.at(-1).prompt).toBe('q\n\n（結果の上限: 2000 字）')
})

test('usage: a file that cannot be read, or is empty, leaves the section as it was and does not fail', async ($, on) => {
  const w = world($, on, { usage: 'missing' })
  await start($)
  for (let i = 0; i < 2; i++) expect(await rules($)).toBe('MODEL')
  expect(w.reads.length).toBe(1) // not asked again within the session
  // and the probe tool still works
  expect((await probe($, { questions: ['q'] })).result).toBe('answer: q')
})

test('usage: an empty file adds nothing', async ($, on) => {
  world($, on, { usage: '  \n' })
  await start($)
  expect(await rules($)).toBe('MODEL')
})

test('usage: read again in a new session', async ($, on) => {
  const w = world($, on)
  await start($)
  await rules($)
  await start($)
  await rules($)
  expect(w.reads.length).toBe(2)
})

// ------------------------------------------------------------------ read-only

test('Bash of a probe subagent runs inside bwrap: read-only file system, TMPDIR in its own /dev', async ($, on) => {
  const w = world($, on, { agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }, { id: 'o1', type: 'general-purpose', status: 'running', description: 'x' }] })
  await start($)
  const command = `echo 'it''s'; ls "$HOME" | head -3`
  await asAgent($, 'p1', { tool: 'Bash', command })
  expect(w.bash).toEqual([wrapCommand(command)])
  expect(w.bash[0]).toBe(
    `bwrap --ro-bind / / --dev /dev --proc /proc --setenv TMPDIR /dev/shm --die-with-parent -- bash -c ${shQuote(command)}`,
  )
  expect(w.bash[0]).toContain(`'echo '\\''it'\\'''\\''s'\\''; ls "$HOME" | head -3'`)
  // others are not touched: another subagent, the main loop
  await asAgent($, 'o1', { tool: 'Bash', command: 'ls' })
  await asAgent($, undefined, { tool: 'Bash', command: 'pwd' })
  expect(w.bash.slice(1)).toEqual(['ls', 'pwd'])
})

test('Bash of a probe subagent: with bwrap unusable, the next sandbox that works wraps it (sandbox-exec)', async ($, on) => {
  const w = world($, on, { bwrap: false, seatbelt: true, agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }] })
  await start($)
  await asAgent($, 'p1', { tool: 'Bash', command: 'ls' })
  expect(w.bash).toEqual([SANDBOXES[1].wrap('ls')])
  expect(w.bash[0]).toContain('/usr/bin/sandbox-exec -D TMP="$d" -p')
  expect(w.bash[0]).toContain("bash -c 'ls'; s=$?; rm -rf \"$d\"; exit $s")
})

test('no sandbox: Bash of a probe subagent passes the gate as is, and tool.check lets only what Bash finds read-only run', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow', reason: 'engine' }))
  const w = world($, on, { bwrap: false, agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }, { id: 'o1', type: 'general-purpose', status: 'running', description: 'x' }] })
  await start($)
  // the gate passes it as is; the check (here given no isReadOnly) refuses it, where another agent's runs
  await asAgent($, 'p1', { tool: 'Bash', command: 'ls' })
  await asAgent($, 'o1', { tool: 'Bash', command: 'pwd' })
  expect(w.bash).toEqual(['pwd'])
  // p1 is no probe call's child: checked at each ask (tool.check, then the gate), each sandbox once there
  expect(w.ran.filter((a) => a[0] === 'bwrap' || a[0] === '/usr/bin/sandbox-exec' || a[0] === 'cmd').length).toBe(6)
  const denied = await bashCheck($, 'p1', false)
  expect(denied.decision).toBe('deny')
  expect(denied.reason).toContain('読み取り専用と判定できるコマンドだけ')
  expect((await bashCheck($, 'p1', true)).decision).toBe('allow')
  expect((await bashCheck($, 'o1', false)).decision).toBe('allow')
  expect((await bashCheck($, undefined, false)).decision).toBe('allow')
})

test('sandbox: checked once per probe call, by its first child Bash; a later call checks anew', async ($, on) => {
  const opts: any = { bwrap: false }
  const w = world($, on, opts)
  await start($)
  const checks = () => w.ran.filter((a) => a[0] === 'bwrap' || a[0] === '/usr/bin/sandbox-exec' || a[0] === 'cmd').length
  await probe($, { questions: ['a'] }) // its child: agent-1
  await asAgent($, 'agent-1', { tool: 'Bash', command: 'ls' })
  await asAgent($, 'agent-1', { tool: 'Bash', command: 'pwd' })
  expect(checks()).toBe(3) // bwrap, sandbox-exec, srt: none here, and not asked again within the call
  opts.bwrap = true
  await probe($, { questions: ['b'] }) // agent-2: none from the first call is carried on
  await asAgent($, 'agent-2', { tool: 'Bash', command: 'ls' })
  // the first call had none, so only what Bash finds read-only ran (nothing here); the second's is wrapped
  expect(w.bash).toEqual([wrapCommand('ls')])
  expect(checks()).toBe(4)
})

test('with a sandbox, tool.check leaves the Bash of a probe subagent to the engine', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask', reason: 'engine' }))
  world($, on, { agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }] })
  await start($)
  expect((await bashCheck($, 'p1', false)).decision).toBe('ask')
})

// PROBE_SANDBOX=off: for a throw-away container (the isolation is the container itself).

test('PROBE_SANDBOX=off: Bash of a probe subagent runs as is, and bwrap is not needed', async ($, on) => {
  mock.env(on, { PROBE_SANDBOX: 'off' })
  const w = world($, on, { bwrap: false, agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }, { id: 'o1', type: 'general-purpose', status: 'running', description: 'x' }] })
  await start($)
  const command = `echo 'it''s' > /root/x; ls "$HOME" | head -3`
  const r = await asAgent($, 'p1', { tool: 'Bash', command })
  expect(r.deny).toBeUndefined()
  expect(w.bash).toEqual([command])
  expect(w.ran.some((argv) => argv[0] === 'bwrap')).toBe(false)
  // others are untouched, as before
  await asAgent($, 'o1', { tool: 'Bash', command: 'ls' })
  await asAgent($, undefined, { tool: 'Bash', command: 'pwd' })
  expect(w.bash.slice(1)).toEqual(['ls', 'pwd'])
})

test('PROBE_SANDBOX=off: the probe tool starts without bwrap, the rest of the gate stays', async ($, on) => {
  mock.env(on, { PROBE_SANDBOX: 'off' })
  const w = world($, on, { bwrap: false, agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }] })
  await start($)
  const r = await probe($, { questions: ['a'] })
  expect(r.deny).toBeUndefined()
  expect(w.spawns.length).toBe(1)
  expect(w.ran.some((argv) => argv[0] === 'bwrap')).toBe(false)
  // writes by the file tools and background Bash are still refused
  expect((await asAgent($, 'p1', { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' })).deny).toContain('読み取り専用')
  expect((await asAgent($, 'p1', { tool: 'Write', file_path: '/x', content: 'c' })).deny).toContain('読み取り専用')
  expect((await asAgent($, 'p1', { tool: 'Bash', command: 'sleep 100', run_in_background: true })).deny).toContain('run_in_background')
  expect(w.bash).toEqual([])
})

// anything but the exact "off" keeps the sandbox: wrapped when bwrap works, else only read-only commands
for (const value of ['', 'on', '1', 'false', 'OFF', 'off ', 'no']) {
  for (const bwrap of [true, false]) {
    test(`PROBE_SANDBOX=${JSON.stringify(value)} keeps the sandbox (bwrap ${bwrap ? 'usable' : 'unusable'})`, async ($, on) => {
      mock.env(on, { PROBE_SANDBOX: value })
      on('tool.check', () => ({ decision: 'allow', reason: 'engine' }))
      const w = world($, on, { bwrap, agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }] })
      await start($)
      await asAgent($, 'p1', { tool: 'Bash', command: 'ls' })
      expect(w.bash).toEqual(bwrap ? [wrapCommand('ls')] : [])
      expect((await bashCheck($, 'p1', false)).decision).toBe(bwrap ? 'allow' : 'deny')
    })
  }
}

test('PROBE_SANDBOX: a failing env read keeps the sandbox (here none: read-only commands only)', async ($, on) => {
  on('env.get', () => { throw new Error('env down') })
  on('tool.check', () => ({ decision: 'ask', reason: 'engine' }))
  world($, on, { bwrap: false, agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }] })
  await start($)
  expect((await bashCheck($, 'p1', false)).decision).toBe('deny')
})

test('background Bash of a probe subagent is refused', async ($, on) => {
  const w = world($, on, { agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }] })
  await start($)
  const r = await asAgent($, 'p1', { tool: 'Bash', command: 'sleep 100', run_in_background: true })
  expect(r.deny).toContain('run_in_background')
  expect(w.bash).toEqual([])
})

test('Edit, Write and NotebookEdit of a probe subagent are refused, others pass', async ($, on) => {
  const w = world($, on, { agents: [{ id: 'p1', type: AGENT, status: 'running', description: 'probe' }, { id: 'o1', type: 'general-purpose', status: 'running', description: 'x' }] })
  await start($)
  const calls: Array<Record<string, unknown>> = [
    { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' },
    { tool: 'Write', file_path: '/x', content: 'c' },
    { tool: 'NotebookEdit', notebook_path: '/x.ipynb', new_source: 's' },
  ]
  for (const c of calls) {
    const r = await asAgent($, 'p1', c)
    expect(r.deny).toContain('読み取り専用')
    const ok = await asAgent($, 'o1', c)
    expect(ok.deny).toBe(undefined)
  }
  expect(w.calls).toEqual(['Edit', 'Write', 'NotebookEdit'])
  expect(w.bash).toEqual([])
})

test('a probe subagent is known from the spawn even when the agent list cannot say', async ($, on) => {
  const w = world($, on, { listThrows: true })
  await start($)
  // The first Bash arrives while the tool call is still running, from the id it spawned.
  let r: any
  w.onPark.push(async () => {
    if (r === undefined) r = await asAgent($, 'agent-1', { tool: 'Bash', command: 'ls /' })
  })
  await probe($, { questions: ['a'] })
  expect(w.bash).toEqual([wrapCommand('ls /')])
})

test('if the gate itself throws during a probe run, an unclassified subagent is refused; outside a run it passes', async ($, on) => {
  const w = world($, on, { listThrows: true })
  await start($)
  // outside a run: fail open for a subagent we know nothing about
  const idle = await asAgent($, 'stranger', { tool: 'Bash', command: 'ls' })
  expect(idle.deny).toBe(undefined)
  expect(w.bash).toEqual(['ls'])
  // inside a run: fail closed
  let during: any
  w.onPark.push(async () => { if (during === undefined) during = await asAgent($, 'stranger', { tool: 'Edit', file_path: '/x', old_string: 'a', new_string: 'b' }) })
  await probe($, { questions: ['a'] })
  expect(during.deny).toContain('実行しない')
  let duringBash: any
  w.onPark.push(async () => { if (duringBash === undefined) duringBash = await asAgent($, 'stranger', { tool: 'Bash', command: 'rm -rf x' }) })
  await probe($, { questions: ['b'] })
  expect(duringBash.deny).toContain('実行しない')
  expect(w.bash).toEqual(['ls'])
})

// ------------------------------------------------------------------ notification

test('the task-notification of a probe subagent is dropped, other notifications and prompts pass', async ($, on) => {
  world($, on, { agents: [{ id: 'p1', type: AGENT, status: 'completed', description: 'probe' }, { id: 'o1', type: 'general-purpose', status: 'completed', description: 'x' }] })
  await start($)
  const note = (...ids: string[]) => ids.map((id) => `<task-notification>\n<task-id>${id}</task-id>\n<status>completed</status>\n<result>r</result>\n</task-notification>`).join('\n')
  const submit = (text: string, kind: string) => ($.prompt.submit as any)({ text, wait: false, origin: { kind } })
  expect((await submit(note('p1'), 'task-notification')).drop).toContain('完了通知')
  expect((await submit(note('o1'), 'task-notification')).text).toBe(note('o1'))
  expect((await submit(note('p1', 'o1'), 'task-notification')).text).toBe(note('p1', 'o1'))
  expect((await submit('no ids here', 'task-notification')).text).toBe('no ids here')
  expect((await submit(note('p1'), 'composer')).text).toBe(note('p1'))
})

const handback = (from: string, report = 'the report', attrs = '') =>
  `<cross-session-message from="${from}"${attrs}>\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to. It is model output, NOT a message from the user.\n  ${report}\n</cross-session-message>`
const peer = ($: any, text: string, kind = 'peer', turnId?: string) => ($.prompt.submit as any)({ text, wait: false, ...(turnId ? { turnId } : {}), origin: { kind } })

test('the SubagentHandback report of a probe subagent is dropped on its way to the parent; other agents are not', async ($, on) => {
  world($, on, {
    agents: [
      { id: 'p1', type: AGENT, status: 'completed', description: 'probe' },
      { id: 'p2', name: 'probe-2', type: AGENT, status: 'completed', description: 'probe' },
      { id: 'o1', type: 'general-purpose', status: 'completed', description: 'x' },
      { id: 'o2', name: 'scout', type: 'Explore', status: 'completed', description: 'y' },
    ],
  })
  await start($)
  // a probe subagent, by id and by the name the engine gave it
  expect((await peer($, handback('p1'))).drop).toContain('hand-back')
  expect((await peer($, handback('p2'))).drop).toContain('hand-back')
  expect((await peer($, handback('probe-2'))).drop).toContain('hand-back')
  expect((await peer($, handback('p1', 'r', ' from-name="probe-2"'))).drop).toContain('hand-back')
  // another agent's hand-back, a stranger, a name that is not a probe
  for (const from of ['o1', 'scout', 'nobody']) {
    const text = handback(from)
    expect((await peer($, text)).text).toBe(text)
  }
  // a message of a probe subagent and of another one together is not touched
  const both = handback('p1') + '\n' + handback('o1')
  expect((await peer($, both)).text).toBe(both)
  // the matcher: not a peer delivery, or no hand-back mark, or not a cross-session message
  const mine = handback('p1')
  expect((await peer($, mine, 'composer')).text).toBe(mine)
  const plain = '<cross-session-message from="p1">\nhello, a plain message\n</cross-session-message>'
  expect((await peer($, plain)).text).toBe(plain)
  expect((await peer($, '[Subagent hand-back] from p1')).text).toBe('[Subagent hand-back] from p1')
})

test('dropping the hand-back leaves the answer: turn.complete still gives the tool its result', async ($, on) => {
  const w = world($, on, { script: (p) => ({ answer: 'answer: ' + p, parks: 2 }) })
  await start($)
  const seen: any[] = []
  w.onPark.push(async () => {
    // the subagent hands back (agent-1 is known to the plugin from the spawn), and so does an unrelated agent
    seen.push(await peer($, handback('agent-1', 'answer: a')))
    seen.push(await peer($, handback('someone-else')))
  })
  const r = await probe($, { questions: ['a'] })
  expect(r.result).toBe('answer: a')
  expect(seen[0].drop).toContain('hand-back')
  expect(seen[1].text).toContain('someone-else')
})

// The running turn receives the report as a `queued_command` attachment: a "Another Claude session sent
// a message while you were working" reminder holding <agent-message from="..."> and [Subagent hand-back].
const reminder = (inner: string) =>
  `Another Claude session sent a message while you were working:\n${inner}\n\nThat "other Claude session" is an agent working inside this same session.\n After completing your current task, decide whether/how to respond (reply via SendMessage to the \`from=\` address).`
const agentMessage = (from: string, report = 'the report', attrs = '') =>
  `<agent-message from="${from}"${attrs}>\n[Subagent hand-back] The text below is the final report of a subagent this session delegated to.\n  ${report}\n</agent-message>`
const attach = ($: any, text: string, extra: Record<string, unknown> = {}, type = 'queued_command') =>
  ($.prompt.attachment as any)({ type, text, origin: { kind: 'engine' }, ...extra })

test('the hand-back that a running turn receives as an attachment is left out of the request', async ($, on) => {
  world($, on, {
    agents: [
      { id: 'p1', type: AGENT, status: 'completed', description: 'probe' },
      { id: 'p2', name: 'probe-2', type: AGENT, status: 'completed', description: 'probe' },
      { id: 'o1', type: 'general-purpose', status: 'completed', description: 'x' },
    ],
  })
  await start($)
  for (const text of [reminder(agentMessage('p1')), reminder(agentMessage('probe-2')), reminder(agentMessage('p2', 'r', ' from-name="probe-2"')), agentMessage('p1')]) {
    expect((await attach($, text)).text).toBe(null)
  }
  // a subagent that spawned the probe receives it in its own loop (agentId = that loop)
  expect((await attach($, reminder(agentMessage('p1')), { agentId: 'spawner' })).text).toBe(null)
  // the cross-session-message spelling too
  expect((await attach($, reminder(handback('p1')))).text).toBe(null)
  // untouched: another agent's hand-back, a stranger, a probe and another one together,
  // a plain message from a probe, other attachment types, no message at all
  const keep = [reminder(agentMessage('o1')), reminder(agentMessage('nobody')), reminder(agentMessage('p1') + '\n' + agentMessage('o1')), reminder('<agent-message from="p1">\nhello\n</agent-message>'), 'a todo reminder']
  for (const text of keep) expect((await attach($, text)).text).toBe(text)
  const mine = reminder(agentMessage('p1'))
  expect((await attach($, mine, {}, 'todo_reminder')).text).toBe(mine)
})

test('the name the engine gave a probe subagent is remembered after it left the agent list', async ($, on) => {
  const w = world($, on, { names: { 'agent-1': 'probe-one' } })
  await start($)
  await probe($, { questions: ['a'] })
  expect(w.live.size).toBe(0)
  expect((await attach($, reminder(agentMessage('probe-one')))).text).toBe(null)
  expect((await attach($, reminder(agentMessage('agent-1')))).text).toBe(null)
  const other = reminder(agentMessage('scout'))
  expect((await attach($, other)).text).toBe(other)
})

test('the attachment hook failing lets the report through; the answer of the tool is unaffected', async ($, on) => {
  const w = world($, on, { listThrows: true })
  await start($)
  const seen: any[] = []
  w.onPark.push(async () => { seen.push(await attach($, reminder(agentMessage('agent-1', 'answer: a')))) })
  const r = await probe($, { questions: ['a'] })
  expect(r.result).toBe('answer: a')
  expect(seen[0].text).toBe(null) // agent-1 is known from the spawn: no list needed
  const text = reminder(agentMessage('stranger'))
  expect((await attach($, text)).text).toBe(text) // unknown sender and the list is down: through
})

test('trace: nothing is written without PROBE_TRACE', async ($, on) => {
  const off = world($, on)
  await start($)
  await attach($, reminder(agentMessage('p1')))
  await peer($, handback('p1'))
  expect(off.traced.length).toBe(0)
})

test('trace: with PROBE_TRACE, the event as each hook saw it is summarised in the log', async ($, on) => {
  const w = world($, on, { trace: true, agents: [{ id: 'p1', type: AGENT, status: 'completed', description: 'probe' }] })
  await start($)
  await attach($, reminder(agentMessage('p1')), { agentId: 'spawner' })
  await attach($, 'no message here')
  await peer($, handback('p1'), 'peer', 'turn-1')
  await peer($, handback('p1'))
  expect(w.traced.length).toBe(3)
  expect(w.ran.filter((a: any) => a[0] === 'sh').every((a: any) => a[4] === '/log/probe-trace.log')).toBe(true)
  expect(w.traced[0]).toMatchObject({ hook: 'prompt.attachment', note: 'left out', type: 'queued_command', agentId: 'spawner' })
  expect(w.traced[0].text).toContain('<agent-message from="p1">')
  expect(w.traced[1]).toMatchObject({ hook: 'prompt.submit', note: 'passed to the queue', origin: { kind: 'peer' }, turnId: 'turn-1' })
  expect(w.traced[2]).toMatchObject({ hook: 'prompt.submit', note: 'dropped', origin: { kind: 'peer' } })
})

test('fallback: an attachment row of a probe subagent\'s hand-back is cut to a stub', async ($, on) => {
  world($, on, { agents: [{ id: 'p1', type: AGENT, status: 'completed', description: 'probe' }] })
  await start($)
  const append = (text: string) =>
    ($.session.append as any)({
      message: { type: 'attachment', name: 'queued_command', role: 'user', isMeta: true, content: [{ type: 'text', text }] },
      door: 'attachment',
      origin: { kind: 'engine' },
      uuid: 'a-' + Math.random().toString(36).slice(2),
    })
  const cut = await append(reminder(agentMessage('p1', 'long long report')))
  expect(cut.message.content[0].text).toContain('hand-back（内容は tool の結果に含まれている）')
  expect(cut.message.content[0].text).not.toContain('long long report')
  const keep = reminder(agentMessage('o1'))
  expect((await append(keep)).message.content[0].text).toBe(keep)
})

test('fallback: a hand-back row of a probe subagent that reaches the conversation is cut to a stub', async ($, on) => {
  world($, on, { agents: [{ id: 'p1', type: AGENT, status: 'completed', description: 'probe' }, { id: 'o1', type: 'general-purpose', status: 'completed', description: 'x' }] })
  const rows = mock.session(on)
  await start($)
  const append = (text: string, kind = 'peer') =>
    ($.session.append as any)({
      message: { type: 'user', role: 'user', isMeta: true, content: [{ type: 'text', text }] },
      door: 'prompt',
      origin: { kind },
      uuid: 'u-' + Math.random().toString(36).slice(2),
    })
  const mine = await append(handback('p1', 'long long report'))
  expect(mine.message.content[0].text).toContain('hand-back（内容は tool の結果に含まれている）')
  expect(mine.message.content[0].text).not.toContain('long long report')
  const other = handback('o1', 'keep me')
  expect((await append(other)).message.content[0].text).toBe(other)
  expect((await append(handback('p1'), 'composer')).message.content[0].text).toContain('[Subagent hand-back]')
  expect(rows.appended().length).toBe(3)
})

test('a hook failure while deciding lets the hand-back through (it is a duplicate, not a danger)', async ($, on) => {
  world($, on, { listThrows: true })
  await start($)
  const text = handback('stranger')
  expect((await peer($, text)).text).toBe(text)
})

test('turn.complete passes through for the main loop and for other agents', async ($, on) => {
  world($, on)
  await start($)
  const base = { turnId: 't', durationMs: 1, isAborted: false, reason: 'answer', answer: 'hello' } as any
  expect((await $.turn.complete(base)).text).toBe('hello')
  expect((await $.turn.complete({ ...base, agentId: 'whoever' })).text).toBe('hello')
})

test('the tool reads like a shell, not a delegate: no word for agents or tasks in what the parent and the child read', async ($, on) => {
  const w = world($, on)
  await start($)
  const t = w.registered.tool
  const forbidden = ['サブエージェント', 'エージェント', 'タスク', 'tasks']
  const texts: Record<string, string> = {
    'tool description': t.description,
    'schema (every description)': JSON.stringify(t.inputSchema),
    'agent prompt': AGENT_PROMPT,
    'agent description': AGENT_SPEC.description,
    'context description': w.registered.context.description,
    'context schema': JSON.stringify(w.registered.context.inputSchema),
    'question prompt': questionPrompt('調べて', 800),
    'rewrite request': rewriteRequest(2500, 2000),
  }
  for (const [what, text] of Object.entries(texts)) {
    for (const word of forbidden) expect(`${what} has ${text.includes(word) ? word : 'no ' + word}`).toBe(`${what} has no ${word}`)
  }
  expect(t.inputSchema.properties.tasks).toBeUndefined()
  expect(t.inputSchema.required).not.toContain('tasks')
})

test('a single answer comes back as bare text, two or more get numbered headings; the old tasks key is refused', async ($, on) => {
  const w = world($, on)
  await start($)
  expect((await probe($, { questions: ['one'] })).result).toBe('answer: one')
  expect((await probe($, { questions: ['one', 'two'] })).result).toBe('## 1\nanswer: one\n\n## 2\nanswer: two')
  const old = await probe($, { tasks: ['one'] })
  expect(old.deny).toContain('questions')
  expect(w.spawns.length).toBe(3)
})

// ------------------------------------------------------------------ pure helpers

test('formatResults numbers sections, caps long answers, writes no path lines', () => {
  expect(formatResults([{ ok: true, text: 'a' }, { ok: false, text: 'ERROR: b' }])).toBe('## 1\na\n\n## 2\nERROR: b')
  // one result: the text alone, no heading (an error too)
  expect(formatResults([{ ok: true, text: 'a' }])).toBe('a')
  expect(formatResults([{ ok: false, text: 'ERROR: b' }])).toBe('ERROR: b')
  const long = formatResults([{ ok: true, text: 'x'.repeat(9000) }])
  expect(long).toContain('…(切り詰め。元は 9000 文字)')
  expect(long).toBe('x'.repeat(2000) + '\n…(切り詰め。元は 9000 文字)')
  expect(long).not.toContain('全文')
  // the bound is the caller's; an answer exactly at the bound is whole; a reason rides in the mark
  expect(formatResults([{ ok: true, text: 'y'.repeat(800) }], 800)).toBe('y'.repeat(800))
  expect(formatResults([{ ok: true, text: 'y'.repeat(801) }], 800)).toBe('y'.repeat(800) + '\n…(切り詰め。元は 801 文字)')
  expect(formatResults([{ ok: true, text: 'z'.repeat(600), why: 'because' }], 500)).toContain('…(切り詰め。元は 600 文字。because)')
  // characters, not UTF-16 units
  expect(lengthOf('あい𠮷')).toBe(3)
  expect(formatResults([{ ok: true, text: '𠮷'.repeat(600) }], 500)).toBe('𠮷'.repeat(500) + '\n…(切り詰め。元は 600 文字)')
  expect(questionPrompt('調べて', 800)).toBe('調べて\n\n（結果の上限: 800 字）')
  expect(formatResults([{ ok: true, text: 'abc', note: '…(要約。元は 900 文字)' }], 500)).toBe('abc\n…(要約。元は 900 文字)')
  expect(shortenPrompt('Q', 'A'.repeat(3), 3, 500)).toBe(['次は調べものの依頼と、その答えである。答えが長すぎるので、500 字以内に書き直す。', '結論を先に書く。数値・名前・ファイル:行・原文の引用など必要な情報だけ残し、経過・前置き・注意書きは削る。答えにないことは書かない。日本語で、書き直した結果だけを返す。', '', '【依頼】', 'Q', '', '【答え（3 字）】', 'AAA'].join('\n'))
  expect(rewriteRequest(2500, 2000)).toBe('結果が 2500 字で、上限 2000 字を超えた。結論を先に、2000 字以内に書き直して。必要な情報だけ残す。書き直した結果だけを最後のメッセージに書く。この依頼や経緯には触れず、ほかの道具で送ることもしない。')
})

test('outcomeOf, taskIdsOf, handbackSendersOf, shQuote and wrapCommand', () => {
  expect(handbackSendersOf(handback('a1'))).toEqual([{ from: 'a1' }])
  expect(handbackSendersOf(handback('a1', 'r', ' from-name="scout"'))).toEqual([{ from: 'a1', name: 'scout' }])
  expect(handbackSendersOf('<cross-session-message from="a1">\nplain\n</cross-session-message>')).toBe(undefined)
  expect(handbackSendersOf('no tag')).toBe(undefined)
  expect(handbackSendersOf(reminder(agentMessage('a1')))).toEqual([{ from: 'a1' }])
  expect(handbackSendersOf(agentMessage('a1') + agentMessage('b2'))).toEqual([{ from: 'a1' }, { from: 'b2' }])
  expect(handbackSendersOf('<agent-message from="a1">\nplain\n</agent-message>')).toBe(undefined)
  expect(outcomeOf({ reason: 'answer', answer: ' x \n' })).toEqual({ ok: true, text: 'x' })
  expect(outcomeOf({ reason: 'answer', answer: ' ' }).ok).toBe(false)
  expect(outcomeOf({ reason: 'aborted', answer: '' }).text).toBe('ERROR: 中断された')
  expect(outcomeOf({ reason: 'refusal', answer: 'no' }).text).toBe('ERROR: 応答を拒否した\nno')
  expect(taskIdsOf('<task-id> a1 </task-id> x <task-id>b2</task-id>')).toEqual(['a1', 'b2'])
  expect(shQuote("a'b")).toBe(`'a'\\''b'`)
  expect(BWRAP_ARGS).toEqual(['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--setenv', 'TMPDIR', '/dev/shm', '--die-with-parent'])
  expect(wrapCommand('ls')).toBe(`bwrap ${BWRAP_ARGS.join(' ')} -- bash -c 'ls'`)
})

// ------------------------------------------------------------------ permission of the spawn

test('tool.check: probe:probe, and TaskStop of a probe subagent, are allowed while a probe call runs; outside a run, and for others, the engine decides', async ($, on) => {
  on('tool.check', () => ({ decision: 'ask', reason: 'engine' }))
  const w = world($, on)
  await start($)
  const check = (type: string) => ($.tool.check as any)({ tool: 'Agent', input: { subagent_type: type, prompt: 'p', description: 'd' } })
  expect((await check(AGENT)).decision).toBe('ask')
  const stop = (id: string) => ($.tool.check as any)({ tool: 'TaskStop', input: { task_id: id } })
  let during: any, other: any, stopOurs: any, stopOther: any
  w.onPark.push(async () => {
    if (during !== undefined) return
    during = await check(AGENT)
    other = await check('general-purpose')
    stopOurs = await stop([...w.live.keys()][0])
    stopOther = await stop('someone-else')
  })
  await probe($, { questions: ['a'] })
  expect(during.decision).toBe('allow')
  expect(other.decision).toBe('ask')
  expect(stopOurs.decision).toBe('allow')
  expect(stopOther.decision).toBe('ask')
})

// ------------------------------------------------------------------ hand-back while a turn runs

test('a probe hand-back submitted while a turn runs passes to the queue (the attachment hook leaves it out); idle, it is dropped', async ($, on) => {
  world($, on, { agents: [{ id: 'p1', type: AGENT, status: 'completed', description: 'probe' }] })
  await start($)
  const running = await peer($, handback('p1'), 'peer', 'turn-1')
  expect(running.drop).toBe(undefined)
  expect((await peer($, handback('p1'))).drop).toContain('hand-back')
  expect((await attach($, agentMessage('p1'))).text).toBe(null)
})
