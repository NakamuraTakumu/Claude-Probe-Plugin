// probe: a read-only investigation tool `probe`, run by hidden haiku
// subagents of this session (no external CLI, no `claude -p`). See docs/design.md.
//
//   probe:probe         agent type (hidden from the model by agent.offer)
//   mcp__probe__probe   tool the parent calls; one hidden subagent per question
//   tool description    what probe is and when it fits: every loop that is offered the tool reads it.
//   prompt.section      appends usage.md (the user's rules for probe, beyond the description) to the system
//                       prompt section `env_info_model`, the one section that the main conversation, the
//                       subagents the model starts and the probe subagents all carry (prompt.compose renders
//                       the main one's only): the same text in the same place everywhere. A line after it
//                       sets it aside where probe is not on offer (a probe subagent reads it too). It
//                       replaces an `@` import of the file in CLAUDE.md, and follows the plugin on and off.
//   /probe-mode        save | handy: which lines of usage.md go in (a line `<!-- save -->` or
//                       `<!-- handy -->` starts lines of that mode only, `<!-- all -->` ends them).
//                       Kept in $.store for later sessions; this session's prompt changes next request.
//                       Any run of it (no argument too) reads usage.md again on the next request.
//   context: false      (input of a probe call) its questions go alone: no "## 背景", and the children
//                       it starts are refused the context tool.
//   effort              (input of a probe call) low ... max: turn.step puts it on each model request of
//                       the children that call started (a spawn takes no effort; AGENT_SPEC's is the default).
//   mcp__probe__context tool of the probe subagents only: reads the conversation of whoever called
//                       probe (user/assistant text, no tool output). Not hideable from the parent
//                       (no tool.offer): placed behind ToolSearch, described as probe-internal, and
//                       a call from anyone but a probe subagent is denied.
//   tool.call gate             Bash of a probe subagent runs inside the first sandbox that works here
//                              (SANDBOXES: bwrap, sandbox-exec, srt): file system read-only, temp files
//                              for the command's own run only. With none, tool.check lets only the
//                              commands Bash itself finds read-only run. Edit/Write/NotebookEdit are
//                              refused. PROBE_SANDBOX=off (exact) leaves the Bash as it is: for a
//                              throw-away container that is the isolation.
//   prompt.submit              drops what a finished probe subagent sends its parent
//                              (its SubagentHandback report, its task-notification):
//                              the tool result already carries the answer
//   max_chars                  upper bound of each answer (default 2000). The question handed to the
//                              subagent names it; an answer above it is sent back to the SAME
//                              subagent (`$.session.send` resumes it; the new answer arrives as
//                              its next `turn.complete`) up to MAX_REVISIONS times, then cut.
//                              Resuming a finished subagent asks `agent.offer` for its type, which
//                              hides probe:probe: the hook says "offered" while a rewrite is out.
//                              If the rewrite cannot be had (not delivered, failed, too slow) the
//                              answer is shortened by `$.model.complete` (no tools), else cut.
//   tool.check                 allows the Agent call that starts probe:probe, and the TaskStop that stops
//                              one, when this plugin raised them (its own $.agent.spawn, TaskStop). Auto mode's server-side classifier gives no
//                              verdict for an action no model response asked for, and refuses it; the
//                              subagent's own tool calls are still decided as any subagent's are.

// "claude-*" is a reserved plugin name (claude plugin validate refuses it), hence probe.
const PLUGIN = 'probe'
const AGENT_NAME = 'probe'
const AGENT_TYPE = 'probe:probe'
const PROBE_TOOL = 'mcp__probe__probe'
const CONTEXT_NAME = 'context'
const CONTEXT_TOOL = 'mcp__probe__context'
const CONTEXT_DEFAULT_LAST = 5
const CONTEXT_MAX_LAST = 50
const CONTEXT_DEFAULT_CHARS = 3000
const CONTEXT_MIN_CHARS = 200
const CONTEXT_MAX_CHARS = 8000
const CONTEXT_GREP_MAX = 200
const REQUESTERS_CAP = 512
const BACKGROUND_USER_TURNS = 3
const USAGE_FILE = 'usage.md'
const USAGE_SECTION = 'env_info_model'
const MODES = ['save', 'handy']
const DEFAULT_MODE = 'handy'
const MODE_KEY = 'mode'
const MODE_COMMAND = 'probe-mode'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const USAGE_MARK = /^<!--\s*(save|handy|all)\s*-->$/
const USAGE_SCOPE = '（mcp__probe__probe を呼べないなら、この節は当てはまらない。）'
const BACKGROUND_CHARS = 1500

const MAX_PARALLEL = 4
const QUESTION_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_MAX_CHARS = 2000
const MIN_MAX_CHARS = 500
const MAX_MAX_CHARS = 8000
const MAX_REVISIONS = 2
const REWRITE_TIMEOUT_MS = 3 * 60 * 1000
const SHORTEN_TIMEOUT_MS = 60 * 1000
const COMPLETIONS_CAP = 256
const CHILD_MODEL = 'haiku' // probe always runs on haiku

// Bash of a probe subagent runs inside the first of SANDBOXES whose check runs here (checked once per probe call):
// the file system read-only, network kept, temp files (mktemp) only for the command's own run.
// bwrap (Linux): the whole tree read-only; TMPDIR in the /dev bwrap makes for the command.
export const BWRAP_ARGS = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--setenv', 'TMPDIR', '/dev/shm', '--die-with-parent']
// sandbox-exec (macOS): writes denied but to /dev/null, the terminal and a directory made for the
// command (TMP, its real path), removed when it ends.
const SEATBELT_PROFILE =
  '(version 1)(allow default)(deny file-write*)(allow file-write* (subpath (param "TMP")) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))'
export const SANDBOXES = [
  { name: 'bwrap', check: ['bwrap', ...BWRAP_ARGS, '--', 'true'], wrap: wrapCommand },
  {
    name: 'sandbox-exec',
    check: ['/usr/bin/sandbox-exec', '-D', 'TMP=/dev/null', '-p', SEATBELT_PROFILE, '/usr/bin/true'],
    wrap: (c) =>
      `d=$(mktemp -d) && d=$(cd "$d" && pwd -P) || exit 1; TMPDIR="$d" /usr/bin/sandbox-exec -D TMP="$d" -p ${shQuote(SEATBELT_PROFILE)} bash -c ${shQuote(c)}; s=$?; rm -rf "$d"; exit $s`,
  },
  // srt (Windows, set up by `claude sandbox install`): writes denied, the network too (srt cannot say "any").
  { name: 'srt', check: ['cmd', '/d', '/c', 'srt -c "exit 0"'], wrap: (c) => `srt -c ${shQuote(c)}` },
]
// park's waits, each a process (a `$` call, free of the hook's budget): sleep, else Windows' ping (~1 s).
const PARKS = [['sleep', '0.5'], ['sleep', '1'], ['ping', '-n', '2', '127.0.0.1']]

export const AGENT_PROMPT = [
  '依頼主の代わりに作業場や Web を調べ、コマンドを実行して結果を返す。依頼されたことだけを最短の手順で行う。ファイルは変更しない。',
  'コマンドはなるべく1回の bash にまとめ、依存しない操作は並列に呼ぶ。Bash のファイルシステムは読み取り専用で、スクラッチパッドにも書けない。',
  `スクリプトはファイルに書かず、python3 - <<'EOF' のように標準入力で渡す。一時ファイルは mktemp で作れるが、そのコマンドが終わると消えるので、同じコマンドの中で使い切る。各 Bash 呼び出しは独立で、cd や環境変数は残らない。`,
  '「## 背景」は参考にする。足りなければ context ツールで依頼主の会話を必要な分だけ読む。',
  `最後のメッセージがそのまま返る。結論を先に、既定では ${DEFAULT_MAX_CHARS} 字以内で書く。依頼の末尾に「結果の上限: N 字」とあれば N 字が上限。長さや形の指定があればそれに従う。前置き・経過・使ったコマンド・注意書きは書かない。`,
  '依頼主は答えを確かめずに使うので、確かめていない推測には「推測」と書く。見つからなかったときは、そう書いて、探した場所と検索語を1行で添える。',
  '失敗したことや分からなかったことはそのまま書く。日本語で書く。',
].join('')

export const AGENT_SPEC = {
  name: AGENT_NAME,
  description: 'probe ツール専用の読み取り専用の調べもの役。probe ツールだけが起動する。',
  prompt: AGENT_PROMPT,
  model: 'haiku',
  effort: 'low',
  tools: ['Bash', 'Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', CONTEXT_TOOL],
  omitClaudeMd: true,
}

export const TOOL_SPEC = {
  name: 'probe',
  description:
    '読み取り専用のシェルで調べて、結論か関係する原文の引用だけを返す。ファイルの検索、コマンドやテストの実行、Web 検索ができ、条件を明示すれば分岐を含む手順も任せられる。' +
    '向くのは、どこにあるか分からないものを広く探すとき、多くのファイルにまたがるとき、長い出力（ログ、コマンドの出力）から要点だけ欲しいとき、Web で調べるとき。これから編集する箇所と、すぐ済む確認は自分でやる。' +
    '判断は、基準を問いに書けるなら任せられる。会話全体の文脈や好みに依る判断は任せず、材料集めに使う。' +
    '答えの事実はそのまま使ってよい。確かめていない推測には「推測」と書かれ、見つからなかったときは探した範囲が書かれる。',
  inputSchema: {
    type: 'object',
    properties: {
      questions: {
        type: 'array',
        items: { type: 'string' },
        minItems: 1,
        description: `知りたいこと。1件に1つの仕事と、返してほしい形（ファイル:行と引用、件数、出典の URL など）を書く。長くなりそうな一覧は「件数と先頭 N 件」のように頼む。複数書くと並列に処理され、結果はまとめて返る（最大${MAX_PARALLEL}件同時。同じディレクトリでビルドする問いは並べない）。`,
      },
      cwd: { type: 'string', description: '実行ディレクトリ。省略すると現在の作業ディレクトリ。' },
      max_chars: {
        type: 'integer',
        minimum: MIN_MAX_CHARS,
        maximum: MAX_MAX_CHARS,
        description: `1件ごとの結果の字数の上限（${MIN_MAX_CHARS}〜${MAX_MAX_CHARS}、省略すると ${DEFAULT_MAX_CHARS}）。引用や一覧が多いときは上げる。超えると短くされるか切り詰められる。`,
      },
      context: {
        type: 'boolean',
        description: 'false なら依頼主の会話を渡さず、問いだけを渡す（省略すると true）。渡すのは直近の数往復の本文だけで、ツールの結果は渡らないので、前の結果で分かったパスや名前は問いに書く。問いだけで足りるなら false にする（会話に引きずられず、安い）。',
      },
      effort: { type: 'string', enum: EFFORTS, description: '調べる側の考える深さ（省略すると low）。手順の多い調べものや、難しい判断には medium 以上。' },
    },
    required: ['questions'],
    additionalProperties: false,
  },
  isDeferred: false,
}

export const CONTEXT_SPEC = {
  name: CONTEXT_NAME,
  description: 'probe の内側専用で、probe の外から呼ぶと拒否される。probe を呼んだ会話の user と assistant の本文だけを、古い順に返す。',
  inputSchema: {
    type: 'object',
    properties: {
      grep: { type: 'string', description: '本文に含まれる文字列、または正規表現（大文字小文字は区別しない）。合う発言だけを返す。' },
      last: { type: 'integer', minimum: 1, maximum: CONTEXT_MAX_LAST, description: `最新から N 件（grep で絞ったあと）。省略すると ${CONTEXT_DEFAULT_LAST}。` },
      max_chars: {
        type: 'integer',
        minimum: CONTEXT_MIN_CHARS,
        maximum: CONTEXT_MAX_CHARS,
        description: `返す字数の上限。省略すると ${CONTEXT_DEFAULT_CHARS}。超えると古い方を切る。`,
      },
    },
    additionalProperties: false,
  },
  // Behind ToolSearch for the parent (no schema in its prompt); a probe subagent has no ToolSearch, so
  // the tool is in front of it all the same.
  isDeferred: true,
}

const CONTEXT_DENY = 'context は probe の内側からだけ使える。'
const CONTEXT_OFF_DENY = 'この probe は会話を渡さない指定（context: false）で呼ばれた。質問だけで答える。'
const READONLY_DENY = 'probe は読み取り専用で、ファイルを変更できない。書き込みが必要な作業は親に戻す。'
const NO_SANDBOX_DENY = 'この環境には probe の Bash を読み取り専用で包む仕組み（bwrap、sandbox-exec、srt）がない。読み取り専用と判定できるコマンドだけ実行できる。'

// ---------------------------------------------------------------- pure helpers

/** POSIX single-quote a string for `sh -c`. */
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** The command line that runs `command` inside bwrap (whole file system read-only). */
export function wrapCommand(command) {
  return `bwrap ${BWRAP_ARGS.join(' ')} -- bash -c ${shQuote(command)}`
}

/** Length in characters (code points, so that a surrogate pair is one). */
export function lengthOf(text) {
  return Array.from(String(text)).length
}

/**
 * The question as the subagent gets it: the recent conversation of whoever asked, as "## 背景" (when
 * there is one), then "## 質問" with the question, then its own upper bound. Without a background the
 * question stands alone.
 */
export function questionPrompt(question, maxChars = DEFAULT_MAX_CHARS, background) {
  const limit = `（結果の上限: ${maxChars} 字）`
  return background ? `## 背景（依頼主との直近の会話）\n${background}\n\n## 質問\n${question}\n\n${limit}` : `${question}\n\n${limit}`
}

/** The deny of a probe call whose hook failed, with why (the `next.error` its `.catch` is given). */
export function failureText(error) {
  const kind = error && error.kind === 'timeout' ? 'フックの持ち時間を超えた' : '例外'
  return `probe の実行に失敗した（${kind}${error && error.message ? `: ${error.message}` : ''}）。`
}

/** What the subagent is asked when its answer is `n` characters long and the bound is `max`. */
export function rewriteRequest(n, max) {
  return `結果が ${n} 字で、上限 ${max} 字を超えた。結論を先に、${max} 字以内に書き直して。必要な情報だけ残す。書き直した結果だけを最後のメッセージに書く。この依頼や経緯には触れず、ほかの道具で送ることもしない。`
}

/** The text itself when it fits in `max` characters, else its first `max` characters and a mark. */
function fit(text, max, why) {
  const chars = Array.from(String(text))
  if (chars.length <= max) return String(text)
  return chars.slice(0, max).join('') + `\n…(切り詰め。元は ${chars.length} 文字${why ? '。' + why : ''})`
}

/**
 * One result: its text alone, no heading. Two or more: `## 1`, `## 2` ... one section per question, in
 * question order. No file path lines. An answer above `maxChars` is cut (marked).
 */
export function formatResults(results, maxChars = DEFAULT_MAX_CHARS) {
  const body = (r) => fit(r ? r.text : 'ERROR: 結果なし', maxChars, r && r.why) + (r && r.note ? '\n' + r.note : '')
  if (results.length === 1) return body(results[0])
  return results.map((r, i) => `## ${i + 1}\n${body(r)}`).join('\n\n')
}

/** The request for `$.model.complete` that shortens an answer which is `n` characters long to `max`. */
export function shortenPrompt(question, answer, n, max) {
  return [
    `次は調べものの依頼と、その答えである。答えが長すぎるので、${max} 字以内に書き直す。`,
    '結論を先に書く。数値・名前・ファイル:行・原文の引用など必要な情報だけ残し、経過・前置き・注意書きは削る。答えにないことは書かない。日本語で、書き直した結果だけを返す。',
    '',
    '【依頼】',
    question,
    '',
    `【答え（${n} 字）】`,
    answer,
  ].join('\n')
}

const SYSTEM_REMINDER = /<system-reminder>[\s\S]*?<\/system-reminder>/g

/** The text of a message without its `<system-reminder>` blocks. */
export function bodyOf(text) {
  return String(text ?? '').replace(SYSTEM_REMINDER, '').trim()
}

/** `grep` as a test on a text: a case-insensitive regular expression, or, when it is not one, a substring. */
export function matcherOf(grep) {
  if (grep === undefined) return () => true
  try {
    const re = new RegExp(grep, 'i')
    return (text) => re.test(text)
  } catch {
    const needle = String(grep).toLowerCase()
    return (text) => text.toLowerCase().includes(needle)
  }
}

/**
 * The conversation as the context tool returns it: only the text of user and assistant messages (no
 * tool output, no system-reminder), the ones that match `grep`, the newest `last` of those, oldest
 * first, each under `### user` / `### assistant`. Above `maxChars` the oldest are left out (marked);
 * a single message that is still too long keeps its end.
 */
export function formatContext(messages, { grep, last = CONTEXT_DEFAULT_LAST, maxChars = CONTEXT_DEFAULT_CHARS } = {}) {
  const match = matcherOf(grep)
  const rows = []
  for (const m of messages) {
    if (!m || (m.role !== 'user' && m.role !== 'assistant')) continue
    const body = bodyOf(m.text)
    if (body && match(body)) rows.push({ heading: `### ${m.role}`, body })
  }
  if (rows.length === 0) return grep === undefined ? '（本文のある発言がない）' : '（該当する発言がない）'
  const picked = rows.slice(-last)
  const reserve = 60 // room for the marks
  const budget = Math.max(1, maxChars - reserve)
  const size = (r) => lengthOf(r.heading) + 1 + lengthOf(r.body)
  let from = 0
  let total = picked.reduce((n, r) => n + size(r) + 2, -2)
  while (total > budget && from < picked.length - 1) total -= size(picked[from++]) + 2
  const kept = picked.slice(from).map((r) => ({ ...r }))
  let cutHead = 0
  if (total > budget) {
    const r = kept[0]
    const room = Math.max(1, budget - lengthOf(r.heading) - 1)
    const chars = Array.from(r.body)
    cutHead = chars.length - room
    r.body = chars.slice(cutHead).join('')
  }
  const lines = []
  if (from > 0) lines.push(`…（上限のため、古い発言 ${from} 件を省略）`)
  kept.forEach((r, i) => {
    lines.push(`${r.heading}\n${i === 0 && cutHead > 0 ? `…（この発言の先頭 ${cutHead} 字を省略）\n` : ''}${r.body}`)
  })
  return lines.join('\n\n')
}

/**
 * The recent exchange of a conversation: the newest `users` user messages that have text and the
 * assistant text between and after them, as formatContext writes it (text only, no tool output, no
 * system-reminder), at most `maxChars` characters, the oldest cut first. undefined when there is none.
 */
export function recentExchange(messages, users = BACKGROUND_USER_TURNS, maxChars = BACKGROUND_CHARS) {
  let from = 0
  let seen = 0
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m && m.role === 'user' && bodyOf(m.text)) {
      from = i
      if (++seen === users) break
    }
  }
  const slice = messages.slice(from)
  if (seen === 0) return undefined
  const text = formatContext(slice, { last: Math.max(1, slice.length), maxChars })
  return text.startsWith('###') || text.startsWith('…') ? text : undefined
}

/** One finished subagent turn -> { ok, text }. */
export function outcomeOf(c) {
  const answer = typeof c.answer === 'string' ? c.answer.trim() : ''
  if (c.reason === 'answer') {
    return answer ? { ok: true, text: answer } : { ok: false, text: 'ERROR: 答えが空だった' }
  }
  const why = c.reason === 'aborted' ? '中断された' : c.reason === 'refusal' ? '応答を拒否した' : 'エラーで終了した'
  return { ok: false, text: `ERROR: ${why}${answer ? '\n' + answer : ''}` }
}

const HANDBACK_MARK = '[Subagent hand-back]'
const HANDBACK_STUB = 'probe: probe の hand-back（内容は tool の結果に含まれている）'

const MESSAGE_TAG = /<(?:cross-session-message|agent-message)\b/

/**
 * Senders of a hand-back delivery. The SubagentHandback tool queues the report for the parent as
 * a peer message: `<cross-session-message from="ID">` in the queue, `<agent-message from="ID">`
 * in the "Another Claude session sent a message while you were working" reminder a running turn
 * receives, each with `[Subagent hand-back] ...` inside.
 * Returns [{ from, name? }] when the text holds such messages (framing around them is ignored)
 * and every one is a hand-back, else undefined.
 */
export function handbackSendersOf(text) {
  const blocks = String(text).split(MESSAGE_TAG).slice(1)
  if (blocks.length === 0) return undefined
  const senders = []
  for (const b of blocks) {
    const end = b.indexOf('>')
    if (end < 0 || !b.slice(end).includes(HANDBACK_MARK)) return undefined
    const head = b.slice(0, end)
    const from = /\bfrom="([^"]+)"/.exec(head)
    if (!from) return undefined
    const name = /\bfrom-name="([^"]+)"/.exec(head)
    senders.push(name ? { from: from[1], name: name[1] } : { from: from[1] })
  }
  return senders
}

/** Task ids named by a notification text (`<task-id>...</task-id>`). */
export function taskIdsOf(text) {
  const ids = []
  const re = /<task-id>\s*([^<\s]+)\s*<\/task-id>/g
  let m
  while ((m = re.exec(String(text))) !== null) ids.push(m[1])
  return ids
}

/** The reason a context call's input is refused, or undefined. */
function validateContext(e) {
  if (e.grep !== undefined && (typeof e.grep !== 'string' || !e.grep.trim() || e.grep.length > CONTEXT_GREP_MAX)) {
    return `grep は空でない ${CONTEXT_GREP_MAX} 字以内の文字列にする。`
  }
  if (e.last !== undefined && (!Number.isInteger(e.last) || e.last < 1 || e.last > CONTEXT_MAX_LAST)) {
    return `last は 1 以上 ${CONTEXT_MAX_LAST} 以下の整数にする。`
  }
  if (e.max_chars !== undefined && (!Number.isInteger(e.max_chars) || e.max_chars < CONTEXT_MIN_CHARS || e.max_chars > CONTEXT_MAX_CHARS)) {
    return `max_chars は ${CONTEXT_MIN_CHARS} 以上 ${CONTEXT_MAX_CHARS} 以下の整数にする。`
  }
  return undefined
}

function validate(e) {
  if (e.context !== undefined && typeof e.context !== 'boolean') return 'context は true か false にする。'
  if (e.effort !== undefined && !EFFORTS.includes(e.effort)) return `effort は ${EFFORTS.join(', ')} のどれかにする。`
  if (!Array.isArray(e.questions) || e.questions.length === 0 || e.questions.some((q) => typeof q !== 'string' || !q.trim())) {
    return 'questions は空でない文字列の配列にする。'
  }
  if (e.cwd !== undefined && (typeof e.cwd !== 'string' || !e.cwd.trim())) return 'cwd は空でない文字列にする。'
  if (e.model !== undefined) return 'model は指定できない（probe は常に haiku で動く）。'
  if (e.max_chars !== undefined && (!Number.isInteger(e.max_chars) || e.max_chars < MIN_MAX_CHARS || e.max_chars > MAX_MAX_CHARS)) {
    return `max_chars は ${MIN_MAX_CHARS} 以上 ${MAX_MAX_CHARS} 以下の整数にする。`
  }
  return undefined
}

// ---------------------------------------------------------------- module state

/** Ids of the subagents this plugin started (never forgotten within a session). */
const probeAgents = new Set()
/** For each probe subagent: the loop whose probe call started it (null: the main conversation). */
const requesters = new Map()
// probe child agentId -> { effort, context } of the call that started it (capped as requesters)
const childCalls = new Map()
/** Names the engine gave the probe subagents (a hand-back may name its sender by it). */
const probeNames = new Set()
/** Ids seen to be someone else's (cache for the gate). */
const otherAgents = new Set()
/** Finished subagent turns by agentId, filled by turn.complete, consumed by the running tool call. */
const completions = new Map()
/** The text of usage.md: undefined = not read yet in this session, null = could not be read (or empty). */
let usageText
let usageMode = DEFAULT_MODE
/** How many probe tool calls are running now. */
let activeRuns = 0
/** How many rewrite requests are out: while above 0, agent.offer lets the probe type be resumed. */
let offerWindow = 0
// Nothing a probe call finds out about this machine (which sandbox, which wait works) is kept for a later
// call: each call is on its own, so one that failed or was cut short leaves the next as it would be anyway.

/** The first of SANDBOXES whose check runs here, else null. */
async function sandboxCheck($) {
  for (const s of SANDBOXES) {
    try {
      if ((await $.process.run(s.check, { timeoutMs: 10000 })).exitCode === 0) return s
    } catch {}
  }
  return null
}

/**
 * The sandbox for the Bash of probe subagent `agentId`: checked once per probe call, by the first of its
 * children to ask, and kept in that call's record. A subagent no call recorded is checked at each ask.
 */
async function sandboxOf($, agentId) {
  const run = childCalls.get(agentId)?.run
  if (run && run.sandbox !== undefined) return run.sandbox
  const box = await sandboxCheck($)
  if (run) run.sandbox = box
  return box
}

/**
 * PROBE_SANDBOX=off: the Bash of a probe subagent is run as it is (no sandbox, no read-only check).
 * For a throw-away environment that is itself the isolation (a benchmark container). Only the exact
 * value `off` counts; unset, empty or anything else keeps the sandbox. Read at every call.
 */
async function sandboxOff($) {
  try {
    return (await $.env.get('PROBE_SANDBOX')) === 'off'
  } catch {
    return false
  }
}

/** Is `agentId` a probe subagent? Known set first, then the engine's agent list (type / spawner). */
async function isProbeAgent($, agentId) {
  if (probeAgents.has(agentId)) return true
  if (otherAgents.has(agentId)) return false
  const list = await $.agent.list()
  const a = list.find((x) => x.id === agentId)
  if (!a) return false
  if (a.type === AGENT_TYPE || a.spawnedBy === PLUGIN) {
    probeAgents.add(agentId)
    return true
  }
  otherAgents.add(agentId)
  return false
}

// Debugging aid, off by default: while PROBE_TRACE names a file, every delivery that looks like
// an agent message is summarised, as each hook sees it, into that file (see docs/design.md).

function textOfEvent(e) {
  if (typeof e.text === 'string') return e.text
  const content = e.message && Array.isArray(e.message.content) ? e.message.content : []
  return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
}

/** One line of JSON appended to the file PROBE_TRACE names, when it is set. */
async function traceLine($, entry) {
  try {
    const log = await $.env.get('PROBE_TRACE')
    if (!log) return
    await $.process.run(['sh', '-c', 'cat >> "$1"', 'sh', log], { stdin: JSON.stringify(entry) + '\n', timeoutMs: 5000 })
  } catch {}
}

async function trace($, hook, e, note) {
  try {
    const text = textOfEvent(e)
    if (!MESSAGE_TAG.test(text) && !text.includes(HANDBACK_MARK)) return
    await traceLine($, {
      hook, note, type: e.type, door: e.door, name: e.message && e.message.name, origin: e.origin, agentId: e.agentId,
      turnId: e.turnId, length: text.length, text: text.slice(0, 2000),
    })
  } catch {}
}

/** Rewrites a conversation row that holds a probe subagent's hand-back to a one-line stub. */
async function cutRow($, e, next) {
  const content = []
  let changed = false
  for (const b of e.message.content) {
    const senders = b.type === 'text' && typeof b.text === 'string' ? handbackSendersOf(b.text) : undefined
    if (senders !== undefined && (await allProbeSenders($, senders))) {
      content.push({ ...b, text: HANDBACK_STUB })
      changed = true
    } else {
      content.push(b)
    }
  }
  await trace($, 'session.append', e, changed ? 'cut to a stub' : 'passed')
  return changed ? next({ ...e, message: { ...e.message, content } }) : next(e)
}

/** Are all the senders of a hand-back probe subagents (by id, or the name the engine gave)? */
async function allProbeSenders($, senders) {
  for (const sender of senders) {
    if (!(await isProbeSender($, sender))) return false
  }
  return true
}

async function isProbeSender($, sender) {
  if (probeAgents.has(sender.from) || probeNames.has(sender.from) || (sender.name !== undefined && probeNames.has(sender.name))) return true
  const list = await $.agent.list()
  const a = list.find((x) => x.id === sender.from || (x.name !== undefined && (x.name === sender.from || x.name === sender.name)))
  return a !== undefined && (await isProbeAgent($, a.id))
}

/**
 * Waits ~0.5 s without spending the hook's own-time budget: a `$` call in flight
 * is free, a bare promise or `$.clock.sleep` is not (10 s per dispatch).
 * `parks.at` is the probe call's own (the first of PARKS not seen to fail in it), and a wait that
 * ends because the call was aborted is not taken for one that cannot run here.
 */
export async function park($, parks, signal) {
  for (; parks.at < PARKS.length; parks.at++) {
    try {
      if ((await $.process.run(PARKS[parks.at], { timeoutMs: 10000 })).exitCode === 0) return
    } catch {}
    if (signal && signal.aborted) return
  }
  try {
    await $.clock.sleep(500, { signal })
  } catch {}
}

async function rememberName($, agentId) {
  try {
    const a = (await $.agent.list()).find((x) => x.id === agentId)
    if (a && typeof a.name === 'string') probeNames.add(a.name)
  } catch {}
}

async function stopAgent($, agentId) {
  try {
    const r = await $.tool.call({ tool: 'TaskStop', task_id: agentId })
    return r.deny === undefined && r.isError !== true
  } catch {
    return false
  }
}

/**
 * Asks the (finished) subagent to write its answer again; whether the request was delivered. Resuming
 * it makes the engine ask `agent.offer` for its type (hidden from the model), so the offer window is
 * open from here on; it stays open when the request was delivered (the caller closes it with
 * closeWindow when the rewrite is over) and shuts at once when not. The outcome goes to the trace.
 */
async function askRewrite($, agentId, n, max) {
  let delivered = false
  let reason
  offerWindow++
  try {
    const r = await $.session.send({ to: { agentId }, text: rewriteRequest(n, max) })
    delivered = r.isDelivered === true
    if (!delivered) reason = r.reason
  } catch (err) {
    reason = `threw: ${err}`
  }
  if (!delivered) offerWindow--
  await traceLine($, { hook: 'rewrite', agentId, delivered, reason, length: n, max })
  return delivered
}

/** Ends the offer window a delivered rewrite of this entry kept open. */
function closeWindow(r) {
  if (r.rewriting) {
    r.rewriting = false
    offerWindow--
  }
}

/**
 * The answer of `r` shortened to `max` characters by one tool-less completion, as a result; when that
 * is not had (no reply, still too long) the answer itself, which formatResults cuts.
 */
async function shortened($, question, r, max, model, signal) {
  const n = lengthOf(r.text)
  let reason = 'no reply'
  try {
    const res = await $.model.complete(
      { model, prompt: shortenPrompt(question, r.text, n, max), maxTokens: Math.min(64000, Math.max(1024, max * 2)), effort: 'low', timeoutMs: SHORTEN_TIMEOUT_MS },
      signal ? { signal } : undefined,
    )
    const text = res.isAnswered ? res.text.trim() : ''
    if (text && lengthOf(text) <= max) {
      await traceLine($, { hook: 'shorten', ok: true, length: n, to: lengthOf(text), max })
      return { ok: true, text, note: `…(要約。元は ${n} 文字)` }
    }
    reason = res.isAnswered ? `still ${lengthOf(text)} chars` : res.reason
  } catch (err) {
    reason = `threw: ${err}`
  }
  await traceLine($, { hook: 'shorten', ok: false, reason, length: n, max })
  return { ok: true, text: r.text, ...(r.why ? { why: r.why } : {}) }
}

// ---------------------------------------------------------------- the usage rules

/** A section's text with the usage rules after it, and the line that sets them aside where probe is not on offer. */
export function withUsage(text, usage) {
  return `${text}\n\n${usage}\n\n${USAGE_SCOPE}`
}

/**
 * usage.md for these settings: a line `<!-- save -->` or `<!-- handy -->` starts lines that go in only
 * in that mode, `<!-- all -->` returns to lines that always go in; the marks themselves are left out.
 */
export function usageFor(text, settings) {
  let only
  const lines = []
  for (const line of String(text).split('\n')) {
    const mark = USAGE_MARK.exec(line.trim())
    if (mark) only = mark[1] === 'all' ? undefined : mark[1]
    else if (only === undefined || settings.includes(only)) lines.push(line)
  }
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

export const MODE_SPEC = {
  name: MODE_COMMAND,
  description: 'probe の使い方の指示を切り替える（save: 親のツール呼び出しを減らす / handy: 便利な道具として使う）。引数なしなら usage.md を読み直す',
  argumentHint: 'save|handy',
}

/** The setting a session starts with: the stored value when it is one of `values`, else `fallback`. */
async function stored($, key, values, fallback) {
  try {
    const value = await $.store.get(key)
    return values.includes(value) ? value : fallback
  } catch {
    return fallback
  }
}

/** usage.md of the plugin (read once per session) for this session's settings; null when it cannot be read or is empty. */
async function usageOf($) {
  if (usageText === undefined) {
    try {
      usageText = String(await $.fs.read(`${$.plugin.root}/${USAGE_FILE}`))
    } catch {
      usageText = null
    }
  }
  const text = usageText === null ? '' : usageFor(usageText, [usageMode])
  return text === '' ? null : text
}

/** `/probe-mode` and `/probe-context`: show the setting, or switch it and keep it for later sessions. */
async function switchSetting($, { command, key, values, current, set }, args) {
  usageText = undefined // read again on the next request
  try {
    $.ui.invalidate('prompt.section') // the section is cached until then
  } catch {}
  const want = String(args ?? '').trim()
  const choices = values.join(' か ')
  if (want === '') return { text: `${command}: 今は ${current}。usage.md は次のリクエストで読み直す。${choices} を指定すると切り替わる。` }
  if (!values.includes(want)) return { text: `${command}: ${want} は指定できない。${choices} を指定する（今は ${current}）。` }
  set(want)
  try {
    await $.store.set(key, want)
  } catch (err) {
    return { text: `${command}: このセッションだけ ${want} にした（保存に失敗した: ${err}）。` }
  }
  return { text: `${command}: ${want} にした。次のリクエストから効く（別のプロセスで動いているセッションは、次に起動したときから）。` }
}

const MODE_SETTING = { command: MODE_COMMAND, key: MODE_KEY, values: MODES, get current() { return usageMode }, set: (v) => { usageMode = v } }

// ---------------------------------------------------------------- the context tool

/** The conversation of whoever called probe, for the probe subagent that asks. */
async function readContext($, e) {
  if (e.agentId === undefined || !requesters.has(e.agentId)) return { deny: CONTEXT_DENY }
  if (childCalls.get(e.agentId)?.context === false) return { deny: CONTEXT_OFF_DENY }
  const bad = validateContext(e)
  if (bad) return { deny: bad }
  const requester = requesters.get(e.agentId)
  let messages
  try {
    messages = requester === null ? await $.session.messages() : await $.session.messages({ agentId: requester })
  } catch {
    return { deny: '依頼主の会話を読めなかった。' }
  }
  if (!Array.isArray(messages)) return { deny: '依頼主の会話は読めない。' }
  return { result: formatContext(messages, { grep: e.grep, last: e.last, maxChars: e.max_chars }) }
}

/** The recent exchange of the conversation that called probe (`agentId`: a loop, else the main one); undefined when it cannot be had. */
async function backgroundOf($, agentId) {
  try {
    const messages = agentId === undefined ? await $.session.messages() : await $.session.messages({ agentId })
    return Array.isArray(messages) ? recentExchange(messages) : undefined
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------- the probe tool

async function runProbe($, e, signal, timeoutMs = QUESTION_TIMEOUT_MS) {
  const bad = validate(e)
  if (bad) return { deny: bad }
  const model = CHILD_MODEL
  const maxChars = e.max_chars ?? DEFAULT_MAX_CHARS
  const background = e.context === false ? undefined : await backgroundOf($, e.agentId)
  const minutes = Math.round(timeoutMs / 60000)
  const results = new Array(e.questions.length)
  const queue = e.questions.map((_, i) => i)
  const parks = { at: 0 }
  const run = { sandbox: undefined } // this call's sandbox, checked by the first child Bash that asks
  // agentId -> { index, deadline, hardDeadline (from the spawn, rewrites included), revisions,
  //              last (last good answer), rewriting (a delivered rewrite is out) }
  const running = new Map()
  activeRuns++
  try {
    for (;;) {
      if (signal && signal.aborted) {
        for (const r of running.values()) closeWindow(r)
        await Promise.all([...running.keys()].map((id) => stopAgent($, id)))
        running.clear()
        return { deny: 'probe は中断された。' }
      }
      const now = await $.clock.now()
      for (const [id, r] of [...running]) {
        const c = completions.get(id)
        if (c) {
          completions.delete(id)
          closeWindow(r)
          const out = outcomeOf(c)
          if (out.ok) r.last = out.text
          // Above the bound: ask the same subagent for a shorter one (its next turn.complete is the
          // new answer; the entry stays in `running`, the deadline stays the spawn's at most).
          if (out.ok && r.revisions < MAX_REVISIONS) {
            const n = lengthOf(out.text)
            if (n > maxChars) {
              if (await askRewrite($, id, n, maxChars)) {
                r.revisions++
                r.rewriting = true
                r.deadline = Math.min(r.hardDeadline, (await $.clock.now()) + REWRITE_TIMEOUT_MS)
              } else {
                // the rewrite cannot be asked for: shorten the answer here
                running.delete(id)
                results[r.index] = { ok: true, text: out.text, shorten: true }
              }
              continue
            }
          }
          running.delete(id)
          // A rewrite that failed (error, empty answer) leaves the last good answer, to be shortened here.
          results[r.index] = !out.ok && r.last !== undefined ? { ok: true, text: r.last, shorten: true } : out
        } else if (now >= r.deadline) {
          closeWindow(r)
          running.delete(id)
          const stopped = await stopAgent($, id)
          results[r.index] =
            r.last !== undefined
              ? {
                  ok: true,
                  text: r.last,
                  shorten: true,
                  why: now >= r.hardDeadline ? `書き直し中に ${minutes} 分でタイムアウト` : `書き直しが ${REWRITE_TIMEOUT_MS / 60000} 分で終わらなかった`,
                }
              : { ok: false, text: `ERROR: タイムアウト（${minutes} 分）。処理を${stopped ? '停止した' : '停止できなかった'}。` }
        }
      }
      while (running.size < MAX_PARALLEL && queue.length > 0) {
        const index = queue.shift()
        const question = e.questions[index]
        let res
        try {
          res = await $.agent.spawn({
            prompt: questionPrompt(question, maxChars, background),
            description: 'probe: ' + question.replace(/\s+/g, ' ').slice(0, 40),
            subagentType: AGENT_TYPE,
            model,
            ...(e.cwd ? { cwd: e.cwd } : {}),
          })
        } catch (err) {
          res = { deny: String(err) }
        }
        if (res.deny !== undefined || !res.agentId) {
          results[index] = { ok: false, text: `ERROR: 開始できなかった: ${res.deny ?? 'agentId がない'}` }
          continue
        }
        probeAgents.add(res.agentId)
        requesters.set(res.agentId, e.agentId ?? null)
        while (requesters.size > REQUESTERS_CAP) requesters.delete(requesters.keys().next().value)
        childCalls.set(res.agentId, { effort: e.effort, context: e.context !== false, run })
        while (childCalls.size > REQUESTERS_CAP) childCalls.delete(childCalls.keys().next().value)
        await rememberName($, res.agentId)
        const deadline = (await $.clock.now()) + timeoutMs
        running.set(res.agentId, { index, deadline, hardDeadline: deadline, revisions: 0, last: undefined, rewriting: false })
      }
      if (running.size === 0 && queue.length === 0) break
      await park($, parks, signal)
    }
  } finally {
    activeRuns--
    // Only reached with agents left running when something threw.
    for (const r of running.values()) closeWindow(r)
    for (const id of running.keys()) await stopAgent($, id)
  }
  // Answers whose rewrite could not be had are shortened here, all at once (cut, marked, when that fails too).
  await Promise.all(
    results.map(async (r, i) => {
      if (r && r.shorten) results[i] = await shortened($, e.questions[i], r, maxChars, model, signal)
    }),
  )
  const text = formatResults(results, maxChars)
  if (results.every((r) => !r.ok)) return { deny: 'probe: すべての問いが失敗した。\n' + text }
  return { result: text }
}

// ---------------------------------------------------------------- hooks

export function register(on) {
  on('session.start', async ($, e, next) => {
    usageText = undefined
    usageMode = await stored($, MODE_KEY, MODES, DEFAULT_MODE)
    try {
      await $.agent.register(AGENT_SPEC)
      await $.tool.register(TOOL_SPEC)
      await $.tool.register(CONTEXT_SPEC)
      await $.command.register(MODE_SPEC)
    } catch (err) {
      $.ui.toast(`probe: 登録に失敗した: ${err}`)
    }
    return next(e)
  })

  // The rules for using probe go after the section env_info_model, which every system prompt carries:
  // the main conversation's, a subagent's, a probe subagent's (see the header). A section core leaves
  // out, a mode with no rules or a failure leaves it as core computed it.
  on('prompt.section', { name: USAGE_SECTION }, async ($, e, next) => {
    const r = await next(e)
    const usage = typeof r.text === 'string' ? await usageOf($) : null
    return usage ? { text: withUsage(r.text, usage) } : r
  }).catch(($, e, next) => next(e))

  on('command.run', { command: MODE_COMMAND }, ($, e) => switchSetting($, MODE_SETTING, e.args)).catch(($, e, next) => next(e))

  // A probe call's effort, on each model request of the children it started (a spawn takes no effort).
  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId === undefined ? undefined : childCalls.get(e.agentId)?.effort
    return yield* next(effort === undefined || effort === e.effort ? e : { ...e, effort })
  })

  // This plugin's own calls, not the model's: the Agent call that starts a probe subagent and the
  // TaskStop that stops one. Allow them (see the header).
  on('tool.check', { tool: ['Agent', 'Task', 'TaskStop'] }, async ($, e, next) => {
    const input = e.input && typeof e.input === 'object' ? e.input : {}
    const ours = e.tool === 'TaskStop' ? probeAgents.has(input.task_id) : input.subagent_type === AGENT_TYPE
    // Raised by this plugin, or while a probe call of it runs (the model is never offered probe:probe).
    if (!ours || (next.origin?.plugin !== PLUGIN && activeRuns === 0)) return next(e)
    return { decision: 'allow', reason: 'probe プラグインが起動し、止める読み取り専用の調べもの役' }
  }).catch(($, e, next) => next(e))

  // Hidden from the model: only this plugin's tool starts it.
  // (Resuming a finished probe subagent for a rewrite asks it too: open while a rewrite request is out.)
  on('agent.offer', { agent: AGENT_TYPE }, () => ({ isOffered: offerWindow > 0 })).catch(() => ({ isOffered: false }))

  // A subagent's answer is its turn.complete; the running probe call picks it up.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId !== undefined) {
      completions.set(e.agentId, { answer: e.answer, reason: e.reason })
      while (completions.size > COMPLETIONS_CAP) completions.delete(completions.keys().next().value)
    }
    return next(e)
  })

  on('tool.call', { tool: PROBE_TOOL }, async ($, e, next) => runProbe($, e, next.signal))
    .catch(($, e, next) => ({ deny: failureText(next.error) }))

  // The context tool: only a probe subagent may call it; it reads the conversation of its requester.
  on('tool.call', { tool: CONTEXT_TOOL }, async ($, e, next) => readContext($, e))
    .catch(($, e, next) => ({ deny: 'context の実行に失敗した。' }))

  // Read-only gate for the probe subagents. A hook that throws is skipped, so the
  // catch handler refuses where the caller is (or may be) a probe subagent.
  on('tool.call', { tool: ['Bash', 'Edit', 'Write', 'NotebookEdit'] }, async ($, e, next) => {
    if (e.agentId === undefined || !(await isProbeAgent($, e.agentId))) return next(e)
    if (e.tool !== 'Bash') return { deny: READONLY_DENY }
    if (e.run_in_background === true) return { deny: 'probe では run_in_background は使えない。コマンドの終了を待つ形で実行する。' }
    if (typeof e.command !== 'string' || !e.command.trim() || (await sandboxOff($))) return next(e)
    const box = await sandboxOf($, e.agentId)
    return next(box ? { ...e, command: box.wrap(e.command) } : e) // no sandbox: the tool.check below
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    if (e.agentId === undefined) return next(e)
    if (probeAgents.has(e.agentId) || (activeRuns > 0 && !otherAgents.has(e.agentId))) {
      return { deny: 'probe の読み取り専用の確認に失敗したため、この呼び出しは実行しない。' }
    }
    return next(e)
  })

  // No sandbox here: a probe subagent's Bash runs only when Bash itself finds the command read-only.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined || e.isReadOnly === true || !(await isProbeAgent($, e.agentId))) return next(e)
    if ((await sandboxOff($)) || (await sandboxOf($, e.agentId)) !== null) return next(e)
    return { decision: 'deny', reason: NO_SANDBOX_DENY }
  }).catch(($, e, next) => (e.agentId !== undefined && probeAgents.has(e.agentId) ? { decision: 'deny', reason: NO_SANDBOX_DENY } : next(e)))

  // The probe tool's result already carries the subagent's answer: do not let what the
  // subagent sends its parent put the same text into the parent's context a second time.
  // (1) its SubagentHandback report. The tool queues it for the parent as a peer message
  //     (not through session.send); a running turn receives it as a `queued_command`
  //     attachment (a "Another Claude session sent a message while you were working"
  //     reminder), an idle session takes it from the queue as a prompt.
  //     In the running turn: prompt.attachment leaves it out of the request.
  on('prompt.attachment', { type: 'queued_command' }, async ($, e, next) => {
    const senders = handbackSendersOf(e.text)
    const drop = senders !== undefined && (await allProbeSenders($, senders))
    await trace($, 'prompt.attachment', e, drop ? 'left out' : 'passed')
    return drop ? { text: null } : next(e)
  }).catch(($, e, next) => next(e))

  //     prompt.submit sees it when it is queued too. While a turn runs (`turnId`) it passes: queued, it
  //     reaches that turn as the attachment above, left out without a trace on screen, whereas a drop
  //     here shows as a "prompt blocked by a hook" row. An idle session would start a turn on it, so
  //     there (a probe call cut short, its subagent reporting late) it is refused.
  on('prompt.submit', { origin: { kind: ['peer', 'coordinator', 'unclassified'] } }, async ($, e, next) => {
    const senders = handbackSendersOf(e.text)
    const probes = senders !== undefined && (await allProbeSenders($, senders))
    const drop = probes && e.turnId === undefined
    await trace($, 'prompt.submit', e, drop ? 'dropped' : probes ? 'passed to the queue' : 'passed')
    return drop ? { drop: 'probe: probe の hand-back は tool の結果に含まれている' } : next(e)
  }).catch(($, e, next) => next(e))

  //     Fallback for either path: a row cannot be refused at session.append, but its text can
  //     be replaced by a one-line stub.
  on('session.append', { origin: { kind: ['peer', 'coordinator', 'unclassified'] } }, cutRow).catch(($, e, next) => next(e))
  on('session.append', { door: ['attachment', 'delivery'] }, cutRow).catch(($, e, next) => next(e))

  // (2) its task-notification.
  on('prompt.submit', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    const ids = taskIdsOf(e.text)
    if (ids.length === 0) return next(e)
    for (const id of ids) {
      if (!(await isProbeAgent($, id))) return next(e)
    }
    return { drop: 'probe: probe の完了通知は tool の結果に含まれている' }
  }).catch(($, e, next) => next(e))
}
