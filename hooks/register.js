// probe: a read-only investigation tool `probe`, run by hidden haiku
// subagents of this session (no external CLI, no `claude -p`). See docs/design.md.
//
//   probe:probe         agent type (hidden from the model by agent.offer)
//   mcp__probe__probe   tool the parent calls; one hidden subagent per question
//   tool description    what probe is and when it fits: every loop that is offered the tool reads it.
//   prompt.attachment   appends usage.md (the user's rules for probe, beyond the description) to the engine's
//   (type model)        model attachment ("You are powered by the model named …"), which the main conversation
//                       and every subagent carry: the same text in the same place everywhere, but none in a
//                       probe subagent (it cannot call probe). The answer is asked again after $.ui.invalidate,
//                       a compaction and a resume in a new process, so a running session gets a changed
//                       usage.md or mode; the system prompt section env_info_model that carried the rules
//                       before is made once per session and stored. It replaces an `@` import of the file in
//                       CLAUDE.md, and follows the plugin on and off.
//   /probe-mode        save | handy: which lines of usage.md go in (a line `<!-- save -->` or
//                       `<!-- handy -->` starts lines of that mode only, `<!-- all -->` ends them).
//                       Kept in $.store for later sessions; this session's prompt changes next request.
//                       Any run of it (no argument too) reads usage.md again on the next request.
//   context: false      (input of a probe call) its questions go alone: no "## 背景", and the children
//                       it starts are refused the context tool.
//   effort              (input of a probe call) low ... max: turn.step puts it on each model request of
//                       the children that call started (a spawn takes no effort; AGENT_SPEC's is the default).
//   run                 (input of a probe call) { name, input }: a tool run once before the questions, as the
//                       caller's own call ($.tool.call: the other hooks, the permission check, then the tool).
//                       Its result as the model reads it heads the answer, unshortened, and each question's
//                       subagent is handed it. A deny (permission refused) is the call's deny: no question runs.
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
//   prompt.attachment          (its SubagentHandback report, its task-notification):
//   session.append             the tool result already carries the answer. Delivered into a running
//                              turn, the row is stored first: session.append cuts it to a stub, and
//                              prompt.attachment leaves the stub out of the request.
//   max_chars                  upper bound of each answer (default 2000). The question handed to the
//                              subagent names it; an answer above it is sent back to the SAME
//                              subagent (`$.session.send` resumes it; the new answer arrives as
//                              its next `turn.complete`) up to MAX_REVISIONS times, then cut.
//                              Resuming a finished subagent asks `agent.offer` for its type, which
//                              hides probe:probe: the hook says "offered" while a rewrite is out.
//                              If the rewrite cannot be had (not delivered, failed, too slow) the
//                              answer is cut. Nothing but the subagent itself writes an answer.
//   〔〕                         probe's own marks (the cut mark, the question heads): in the subagent's
//                              text it becomes （）, so an answer cannot pass for one.
//   tool.check                 allows the Agent call that starts probe:probe, and the TaskStop that stops
//                              one, when this plugin raised them (its own $.agent.spawn, TaskStop). Auto mode's server-side classifier gives no
//                              verdict for an action no model response asked for, and refuses it; the
//                              subagent's own tool calls are still decided as any subagent's are.

import { atom, memberOf, read, update } from 'claude-code'

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
const USAGE_ATTACHMENT = 'model'
// The heading of every usage.md so far: probe 0.4.0 and before wrote the rules into the section env_info_model,
// whose text the model attachment stores; from it on, that text is taken out before the rules go in again.
const STORED_USAGE_HEADING = '# probe の使い分け'
const MODES = ['save', 'handy']
const DEFAULT_MODE = 'handy'
const MODE_KEY = 'mode'
const MODE_COMMAND = 'probe-mode'
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max']
const USAGE_MARK = /^<!--\s*(save|handy|all)\s*-->$/
const BACKGROUND_CHARS = 1500

const MAX_PARALLEL = 16 // a call's subagents at once; the session's cap (CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS) holds too
const QUESTION_TIMEOUT_MS = 15 * 60 * 1000
const DEFAULT_MAX_CHARS = 2000
const MIN_MAX_CHARS = 500
const MAX_MAX_CHARS = 8000
const MAX_REVISIONS = 2
const REWRITE_TIMEOUT_MS = 3 * 60 * 1000
const WRAPUP_TIMEOUT_MS = 2 * 60 * 1000 // a question past its time is asked for what it found so far, and waited for this long
const HANDBACK_TOOL = 'SubagentHandback' // how a subagent hands its answer back: neither refused nor listed
const COMPLETIONS_CAP = 256
const CHILD_MODEL = 'haiku' // probe always runs on haiku
// Keys of a tool call's input that are the engine's, not the tool's (ToolCallReserved, AgentLoop): a `run` input may
// not set them (`consent` would speak for the person).
const RESERVED_INPUT_KEYS = ['tool', 'tool_use_id', 'consent', 'agentId']

// Bash of a probe subagent runs inside the first of SANDBOXES whose check runs here (checked once per probe call):
// the file system read-only, no network, temp files (mktemp) only for the command's own run. Its calls run
// unreviewed when auto mode gives no verdict (the wrapping changed them), so nothing in it may write or send.
// bwrap (Linux): the whole tree read-only; TMPDIR in the /dev bwrap makes for the command.
export const BWRAP_ARGS = ['--ro-bind', '/', '/', '--dev', '/dev', '--proc', '/proc', '--setenv', 'TMPDIR', '/dev/shm', '--unshare-net', '--die-with-parent']
// sandbox-exec (macOS): the network denied, writes denied but to /dev/null, the terminal and a directory made for the
// command (TMP, its real path), removed when it ends.
const SEATBELT_PROFILE =
  '(version 1)(allow default)(deny network*)(deny file-write*)(allow file-write* (subpath (param "TMP")) (literal "/dev/null") (literal "/dev/zero") (literal "/dev/tty") (regex #"^/dev/fd/"))'
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

// Four paragraphs: what the work is, how to go about it, what the environment allows, how to answer.
export const AGENT_PROMPT = [
  '依頼主の代わりに作業場や Web を調べ、コマンドを実行して結果を返す。依頼されたことだけを最短の手順で行う。ファイルは変更しない。',
  'コマンドはなるべく1回の bash にまとめ、依存しない操作は並列に呼ぶ。「## 背景」は参考にし、足りなければ context ツールで依頼主の会話を必要な分だけ読む。',
  `Bash のファイルシステムは読み取り専用で、スクラッチパッドにも書けない。ネットワークにもつながらないので、Web は WebSearch と WebFetch で調べる。スクリプトはファイルに書かず、python3 - <<'EOF' のように標準入力で渡す。一時ファイルは mktemp で作れるが、そのコマンドが終わると消えるので、同じコマンドの中で使い切る。各 Bash 呼び出しは独立で、cd や環境変数は残らない。`,
  `最後のメッセージがそのまま返る。結論を先に、既定では ${DEFAULT_MAX_CHARS} 字以内で、日本語で書く。依頼の末尾に「結果の上限: N 字」とあれば N 字が上限。長さや形の指定があればそれに従う。前置き・経過・使ったコマンド・注意書きは書かない。依頼主は答えを確かめずに使うので、確かめていない推測には「推測」と書き、失敗したことや分からなかったことはそのまま書く。見つからなかったときは、そう書いて、探した場所と検索語を1行で添える。`,
].join('\n\n')

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
    'ツールを1つ一緒に実行させると、その結果も加工せずに返す。' +
    '向くのは、どこにあるか分からないものを広く探すとき、多くのファイルにまたがるとき、長い出力（ログ、コマンドの出力）から要点だけ欲しいとき、Web で調べるとき。' +
    '判断は、基準を問いに書けるなら任せられる。会話全体の文脈や好みに依る判断は任せず、材料集めに使う。' +
    '答えの事実はそのまま使ってよい。確かめていない推測には「推測」と書かれ、見つからなかったときは探した範囲が書かれる。〔〕 は probe が付ける印。',
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
        description: `1件ごとの結果の字数の上限（${MIN_MAX_CHARS}〜${MAX_MAX_CHARS}、省略すると ${DEFAULT_MAX_CHARS}）。引用や一覧が多いときは上げる。超えると書き直させ、それでも超えれば切り詰める。`,
      },
      context: {
        type: 'boolean',
        description: 'false なら依頼主の会話を渡さず、問いだけを渡す（省略すると true）。渡すのは直近の数往復の本文だけで、ツールの結果は渡らないので、前の結果で分かったパスや名前は問いに書く。問いだけで足りるなら false にする（会話に引きずられず、安い）。',
      },
      effort: { type: 'string', enum: EFFORTS, description: '調べる側の考える深さ（省略すると low）。手順の多い調べものや、難しい判断には medium 以上。' },
      run: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'ツールの名前（Bash、Read、mcp__server__tool など）。' },
          input: { type: 'object', description: 'そのツールの入力。' },
        },
        required: ['name', 'input'],
        additionalProperties: false,
        description:
          '問いの前に1回実行するツール。権限の確認は自分で呼んだときと同じで、cwd は効かない。結果は加工されずに答えの前に返り、問いはその結果も見て調べる。' +
          '自分でツールを1回使うか probe に頼むかで迷うときに、その1回をここに入れる。ビルドやテストを実行させ、失敗したときの原因を questions で調べさせるのにも使える。',
      },
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
const GATE_FAIL_DENY = 'probe の読み取り専用の確認に失敗したため、この呼び出しは実行しない。'
const SANDBOXED_ALLOW = 'probe のサンドボックスの中（ファイルは読み取り専用、ネットワークなし）で実行する。'
const NO_SANDBOX_DENY = 'この環境には probe の Bash を読み取り専用で包む仕組み（bwrap、sandbox-exec、srt）がない。読み取り専用と判定できるコマンドだけ実行できる。'

// ---------------------------------------------------------------- pure helpers

/** POSIX single-quote a string for `sh -c`. */
export function shQuote(s) {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

/** The command line that runs `command` inside bwrap (whole file system read-only). */
// With `seconds`, the command is stopped that long after it starts (TERM, then KILL 2 s later), so that it ends
// before Bash's own timeout: past that Bash moves it to the background, where it runs on after the probe call
// and its completion notice reaches the conversation that called probe.
export function wrapCommand(command, seconds) {
  if (seconds === undefined) return `bwrap ${BWRAP_ARGS.join(' ')} -- bash -c ${shQuote(command)}`
  const inner =
    `timeout -k 2 ${seconds} bash -c ${shQuote(command)}; r=$?; ` +
    `if [ "$r" -eq 124 ] || [ "$r" -eq 137 ]; then echo ${shQuote(stoppedNote(seconds))} >&2; fi; exit $r`
  return `bwrap ${BWRAP_ARGS.join(' ')} -- bash -c ${shQuote(inner)}`
}

export function stoppedNote(seconds) {
  return `（probe が ${seconds} 秒で打ち切った。対象を絞るか、Bash の timeout を長く指定する）`
}

// Bash's own timeout for a call: its `timeout` (ms) if given, else BASH_DEFAULT_TIMEOUT_MS, else 2 minutes; at
// most 10 minutes. The command is stopped STOP_MARGIN_S before it.
export const BASH_DEFAULT_TIMEOUT_MS = 120000
const BASH_MAX_TIMEOUT_MS = 600000
const STOP_MARGIN_S = 5
export function stopSeconds(timeoutMs, defaultMs = BASH_DEFAULT_TIMEOUT_MS) {
  const given = typeof timeoutMs === 'number' && timeoutMs > 0 ? timeoutMs : defaultMs
  return Math.max(1, Math.floor(Math.min(given, BASH_MAX_TIMEOUT_MS) / 1000) - STOP_MARGIN_S)
}
async function bashDefaultMs($) {
  try {
    const v = Number(await $.env.get('BASH_DEFAULT_TIMEOUT_MS'))
    return Number.isFinite(v) && v > 0 ? v : BASH_DEFAULT_TIMEOUT_MS
  } catch {
    return BASH_DEFAULT_TIMEOUT_MS
  }
}

/** Length in characters (code points, so that a surrogate pair is one). */
export function lengthOf(text) {
  return Array.from(String(text)).length
}

/**
 * The question as the subagent gets it: the recent conversation of whoever asked, as "## 背景" (when
 * there is one), the tool the call ran first and its result (when it names one), then "## 質問" with the
 * question, then its own upper bound. With neither the question stands alone.
 */
export function questionPrompt(question, maxChars = DEFAULT_MAX_CHARS, background, ran) {
  const limit = `（結果の上限: ${maxChars} 字）`
  const before = []
  if (background) before.push(`## 背景（依頼主との直近の会話）\n${background}`)
  if (ran) before.push(ranSection(ran))
  return before.length === 0 ? `${question}\n\n${limit}` : [...before, `## 質問\n${question}`, limit].join('\n\n')
}

/** What the call's tool was and what it gave, for the subagent: its requester gets that result as it is. */
export function ranSection(ran) {
  return [
    '## 依頼主が先に実行したツール',
    '依頼主はこのツールを実行し、結果をそのまま受け取っている。質問に答えるのに使ってよいが、答えに結果を写さない。',
    `ツール: ${ran.name}`,
    `入力: ${JSON.stringify(ran.input)}`,
    `結果${ran.isError ? '（エラー）' : ''}:`,
    `<result>\n${ran.text}\n</result>`,
  ].join('\n')
}

/** The heading of the tool's result in the answer. */
function ranHeading(ran) {
  return `〔${escapeMarks(ran.name)} の結果${ran.isError ? '（エラー）' : ''}〕`
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

/** What a subagent past its time is asked for: its answer so far, by the usual rules, with no more lookups. */
export function wrapupRequest(minutes, max) {
  return `時間切れ（${minutes} 分）。これ以上は調べない（道具は断られる）。ここまでで分かったことを、ふつうの答えと同じ決まりで、結論を先に ${max} 字以内で書く。時間内に調べきれなかったことは、分からなかったこととして書く。書いた答えだけを最後のメッセージに書く。`
}

export const WRAPUP_DENY = 'probe の時間切れのため、道具は使えない。ここまでで分かったことを答えとして書き、最後のメッセージにする。'

/** Whether `e` (a tool call) comes from a probe subagent past its time, and is not the hand-back. */
function wrappingUp(e) {
  return e.agentId !== undefined && e.tool !== HANDBACK_TOOL && childCalls.get(e.agentId)?.wrapping === true
}

/** The subagent's own text, with probe's brackets 〔〕 turned into （） so that no mark of probe can be written by it. */
export function escapeMarks(text) {
  return String(text).replace(/〔/g, '（').replace(/〕/g, '）')
}

/** The text itself when it fits in `max` characters, else its first `max` characters and a mark. */
function fit(text, max, why) {
  const chars = Array.from(String(text))
  if (chars.length <= max) return String(text)
  return chars.slice(0, max).join('') + `\n〔切り詰め：元は ${chars.length} 字${why ? '。' + why : ''}〕`
}

/**
 * One result: its text alone, no heading. Two or more: `〔問い 1〕`, `〔問い 2〕` ... one section per
 * question, in question order. No file path lines. An answer above `maxChars` is cut (marked).
 * With the tool the call ran first (`ran`): its result, uncut, under `〔<tool> の結果〕`, then every answer
 * under its `〔問い N〕`, one too.
 */
export function formatResults(results, maxChars = DEFAULT_MAX_CHARS, ran) {
  const body = (r) => fit(r ? r.text : 'ERROR: 結果なし', maxChars, r && r.why)
  const answers = results.length === 1 && !ran ? body(results[0]) : results.map((r, i) => `〔問い ${i + 1}〕\n${body(r)}`).join('\n\n')
  return ran ? `${ranHeading(ran)}\n${escapeMarks(ran.text)}\n\n${answers}` : answers
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
const NOTIFICATION_STUB = 'probe: probe の完了通知（内容は tool の結果に含まれている）'

// The engine's note on a delivery of the tools its sender used that the conversation has not been told
// of (for a probe, nothing the parent needs: the answer is in the tool result). Wrapped in a reminder in the stored row; prompt.attachment
// gets the text with that wrapper taken off, as the engine puts its own around the whole.
const TOOLS_USED = /<tools-used-before-summary>[\s\S]*?<\/tools-used-before-summary>/g

/**
 * Is `text`, its `<system-reminder>` blocks and tools-used notes aside, nothing but the stubs cutRow
 * leaves? A request carries a row as stored, so prompt.attachment sees a delivery cut at session.append
 * as its stub. A message the person sends into a running turn comes under the engine's line saying so:
 * a stub quoted in it is no stub here.
 */
export function onlyStubs(text) {
  const lines = bodyOf(String(text ?? '').replace(TOOLS_USED, '')).split('\n').map((l) => l.trim()).filter((l) => l !== '')
  return lines.length > 0 && lines.every((l) => l === HANDBACK_STUB || l === NOTIFICATION_STUB)
}

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

/** Is `text` a notification of probe subagents only (it names task ids, every one a probe subagent's)? */
async function probeNotification($, text) {
  const ids = taskIdsOf(text)
  if (ids.length === 0) return false
  for (const id of ids) {
    if (!(await isProbeAgent($, id))) return false
  }
  return true
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
  if (e.run !== undefined) return validateRun(e.run)
  return undefined
}

function validateRun(t) {
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  if (!isObject(t) || typeof t.name !== 'string' || !t.name.trim() || !isObject(t.input)) {
    return 'run は { name: ツールの名前, input: その入力（オブジェクト） } にする。'
  }
  if (Object.keys(t).some((k) => k !== 'name' && k !== 'input')) return 'run に書けるのは name と input だけ。'
  if (t.name === PROBE_TOOL || t.name === CONTEXT_TOOL) return `run に ${t.name} は指定できない。`
  const reserved = RESERVED_INPUT_KEYS.filter((k) => Object.hasOwn(t.input, k))
  if (reserved.length > 0) return `run の input に ${reserved.join(', ')} は書けない。`
  if (t.input.run_in_background === true) return 'run のツールは終わるのを待つ形で実行する（run_in_background は使えない）。'
  return undefined
}

/**
 * Runs the call's `run` tool once, as its caller's own call (the loop the probe call runs in): the other hooks,
 * the permission check, then the tool. `{ name, input, text, isError }`, or `{ deny }` when it did not run.
 */
async function runFirst($, tool) {
  let r
  try {
    r = await $.tool.call({ ...tool.input, tool: tool.name })
  } catch (err) {
    return { deny: `${tool.name} を実行できなかった: ${err && err.message ? err.message : String(err)}` }
  }
  if (r.deny !== undefined) return { deny: `${tool.name} は実行されなかった: ${r.deny}` }
  const text = typeof r.text === 'string' ? r.text : JSON.stringify(r.result ?? null)
  return { name: tool.name, input: tool.input, text, isError: r.isError === true }
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

const TRACE_KEY = 'trace'
const TRACED = [MESSAGE_TAG, HANDBACK_MARK, '<task-notification>', 'probe: probe の', 'tools-used-before-summary']

function textOfEvent(e) {
  if (typeof e.text === 'string') return e.text
  const content = e.message && Array.isArray(e.message.content) ? e.message.content : []
  return content.map((b) => (b && b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('\n')
}

/**
 * One line of JSON appended to the file PROBE_TRACE names, or else the store's `trace` key (a running
 * session takes no new environment; the store it reads again on each call), when one is set.
 */
async function traceLine($, entry) {
  try {
    const log = (await $.env.get('PROBE_TRACE')) || (await $.store.get(TRACE_KEY))
    if (typeof log !== 'string' || log === '') return
    await $.process.run(['sh', '-c', 'cat >> "$1"', 'sh', log], { stdin: JSON.stringify(entry) + '\n', timeoutMs: 5000 })
  } catch {}
}

async function trace($, hook, e, note) {
  try {
    const text = textOfEvent(e)
    if (!TRACED.some((t) => (typeof t === 'string' ? text.includes(t) : t.test(text)))) return
    await traceLine($, {
      hook, note, type: e.type, door: e.door, name: e.message && e.message.name, origin: e.origin, agentId: e.agentId,
      turnId: e.turnId, length: text.length, text: text.slice(0, 2000),
    })
  } catch {}
}

/**
 * Rewrites a conversation row that holds what a probe subagent sent its parent to a one-line stub: its
 * hand-back, or its task-notification (only in a row the engine marks as one: the person's own message,
 * a reminder like it, may quote a notification).
 */
async function cutRow($, e, next) {
  const content = []
  let changed = false
  const notice = e.origin !== undefined && e.origin !== null && e.origin.kind === 'task-notification'
  for (const b of e.message.content) {
    const text = b.type === 'text' && typeof b.text === 'string' ? b.text : undefined
    const senders = text !== undefined ? handbackSendersOf(text) : undefined
    let stub
    if (senders !== undefined && (await allProbeSenders($, senders))) stub = HANDBACK_STUB
    else if (notice && text !== undefined && (await probeNotification($, text))) stub = NOTIFICATION_STUB
    if (stub !== undefined) {
      content.push({ ...b, text: stub })
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
  return askAgain($, agentId, rewriteRequest(n, max), { hook: 'rewrite', length: n, max })
}

/** Asks the (still running) subagent past its time for its answer so far; whether it was delivered. */
async function askWrapup($, agentId, minutes, max) {
  return askAgain($, agentId, wrapupRequest(minutes, max), { hook: 'wrapup', max })
}

async function askAgain($, agentId, text, info) {
  let delivered = false
  let reason
  offerWindow++
  try {
    const r = await $.session.send({ to: { agentId }, text })
    delivered = r.isDelivered === true
    if (!delivered) reason = r.reason
  } catch (err) {
    reason = `threw: ${err}`
  }
  if (!delivered) offerWindow--
  await traceLine($, { ...info, agentId, delivered, reason })
  return delivered
}

/** Ends the offer window a delivered rewrite of this entry kept open. */
function closeWindow(r) {
  if (r.rewriting) {
    r.rewriting = false
    offerWindow--
  }
}

// ---------------------------------------------------------------- the usage rules

/** The model attachment's text with the usage rules after it. */
export function withUsage(text, usage) {
  return `${text}\n\n${usage}`
}

/** The model attachment's text without the rules an older probe stored in it (from their heading on). */
export function withoutStoredUsage(text) {
  const at = String(text).indexOf(`\n\n${STORED_USAGE_HEADING}\n`)
  return at < 0 ? text : text.slice(0, at)
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
    $.ui.invalidate('prompt.attachment') // the attachment's answer is kept until then
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
  if (wrappingUp(e)) return { deny: WRAPUP_DENY }
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

/** A spawn refused for the session's cap on subagents at once, in the engine's words ($.agent.spawn's, the Agent tool's). */
export function atCapacity(deny) {
  return /spawns are running at once|Concurrent subagent limit reached/.test(String(deny ?? ''))
}

async function runProbe($, e, signal, timeoutMs = QUESTION_TIMEOUT_MS) {
  const bad = validate(e)
  if (bad) return { deny: bad }
  const ran = e.run === undefined ? undefined : await runFirst($, e.run)
  if (ran && ran.deny !== undefined) return { deny: signal && signal.aborted ? 'probe は中断された。' : ran.deny }
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
  let waitFrom // since when the next question has found the session's cap full with none of this call's running
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
          if (!out.ok) {
            running.delete(id)
            // A rewrite that failed (error, empty answer) leaves the last good answer (cut when too long).
            results[r.index] = r.last !== undefined ? { ok: true, text: r.last } : out
            continue
          }
          const text = escapeMarks(out.text)
          r.last = text
          const n = lengthOf(text)
          // Above the bound: ask the same subagent to write it again (its next turn.complete is the new
          // answer; the entry stays in `running`, the deadline stays the spawn's at most). Not the answer so
          // far of one past its time, nor past MAX_REVISIONS, nor when the request cannot be delivered: that
          // answer is taken as it is (cut).
          if (!r.wrapping && r.revisions < MAX_REVISIONS && n > maxChars) {
            if (await askRewrite($, id, n, maxChars)) {
              r.revisions++
              r.rewriting = true
              r.deadline = Math.min(r.hardDeadline, (await $.clock.now()) + REWRITE_TIMEOUT_MS)
              continue
            }
          }
          running.delete(id)
          results[r.index] = { ok: true, text }
        } else if (now >= r.deadline) {
          // Past its time with no answer yet: ask for what it found so far (tools refused from here on), once.
          if (!r.wrapping && r.last === undefined && !r.rewriting && (await askWrapup($, id, minutes, maxChars))) {
            r.wrapping = true
            r.rewriting = true // the offer window stays open while the request is out (closeWindow ends it)
            const c = childCalls.get(id)
            if (c) c.wrapping = true
            r.deadline = now + WRAPUP_TIMEOUT_MS
            continue
          }
          closeWindow(r)
          running.delete(id)
          const stopped = await stopAgent($, id)
          results[r.index] =
            r.last !== undefined
              ? {
                  ok: true,
                  text: r.last,
                  why: now >= r.hardDeadline ? `書き直し中に ${minutes} 分でタイムアウト` : `書き直しが ${REWRITE_TIMEOUT_MS / 60000} 分で終わらなかった`,
                }
              : { ok: false, text: `ERROR: タイムアウト（${minutes} 分）。${r.wrapping ? `途中までの答えも ${WRAPUP_TIMEOUT_MS / 60000} 分で返らなかった。` : ''}処理を${stopped ? '停止した' : '停止できなかった'}。` }
        }
      }
      while (running.size < MAX_PARALLEL && queue.length > 0) {
        const index = queue[0]
        const question = e.questions[index]
        let res
        try {
          res = await $.agent.spawn({
            prompt: questionPrompt(question, maxChars, background, ran),
            description: 'probe: ' + question.replace(/\s+/g, ' ').slice(0, 40),
            subagentType: AGENT_TYPE,
            model,
            ...(e.cwd ? { cwd: e.cwd } : {}),
          })
        } catch (err) {
          res = { deny: String(err) }
        }
        if (res.deny !== undefined || !res.agentId) {
          // The session's cap on subagents at once (this call's and others', a parallel probe call's say): the
          // question waits for one to finish, up to the question time when none of this call's is running.
          if (atCapacity(res.deny)) {
            if (running.size > 0) break
            waitFrom ??= now
            if (now - waitFrom < timeoutMs) break
          }
          queue.shift()
          results[index] = { ok: false, text: `ERROR: 開始できなかった: ${res.deny ?? 'agentId がない'}` }
          continue
        }
        queue.shift()
        waitFrom = undefined
        probeAgents.add(res.agentId)
        requesters.set(res.agentId, e.agentId ?? null)
        while (requesters.size > REQUESTERS_CAP) requesters.delete(requesters.keys().next().value)
        childCalls.set(res.agentId, { effort: e.effort, context: e.context !== false, run, wrapping: false })
        while (childCalls.size > REQUESTERS_CAP) childCalls.delete(childCalls.keys().next().value)
        if (e.agentId === undefined && typeof e.tool_use_id === 'string') {
          callChildren.set(e.tool_use_id, [...(callChildren.get(e.tool_use_id) ?? []), res.agentId])
          while (callChildren.size > SAVINGS_CAP) callChildren.delete(callChildren.keys().next().value)
        }
        await rememberName($, res.agentId)
        const deadline = (await $.clock.now()) + timeoutMs
        running.set(res.agentId, { index, deadline, hardDeadline: deadline, revisions: 0, last: undefined, rewriting: false, wrapping: false })
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
  const text = formatResults(results, maxChars, ran)
  // With a tool that ran, its result is the caller's even when every question failed.
  if (!ran && results.every((r) => !r.ok)) return { deny: 'probe: すべての問いが失敗した。\n' + text }
  return { result: text }
}

// ---------------------------------------------------------------- savings estimate
//
// After each probe call of the main loop, one line for the person, drawn on the call's own row (ui.render
// ToolUse) once the estimate can be made; not sent to the model, not kept in the transcript file: what the
// call saved in API prices against the main loop doing the same work itself. The calculation is the trial
// script's of 2026-11-05 (docs/design.md, 節約の見積もり), read from the same transcript files: the main
// loop's and each subagent's.

// The line of each call, by its tool_use_id (a member per row: memberOf). Written by showSavings; the row's
// drawing reads it, so the write draws that row again.
const savingsShown = atom({ plugin: 'probe', key: 'savings' }, '')

const PRICE_OPUS = { in: 4, w5: 5, w1h: 8, read: 0.2, out: 20 } // $ per million tokens, claude-opus-5-5
const PRICE_HAIKU = [0.1, 0.5] // claude-haiku-5-5 input and output, a prompt of up to 100K tokens
const PRICE_HAIKU_LONG = [0.5, 2.5] // above that
const HAIKU_LONG_AT = 100_000
const PER_M = 1_000_000
const TRANSCRIPT_READ_MAX = 4 * 1024 * 1024 - 1024 // $.fs.read rejects over 4 MiB: a longer file is read from its end
const SAVINGS_TRIES = 8 // estimates tried for a call (main-loop steps) before the request after it is given up on
const SAVINGS_CAP = 64

/** Prices of a claude-haiku-5-5 request by its prompt (input, cache writes 5 m / 1 h, cache read, output). */
export function haikuPrice(prompt) {
  const [i, o] = prompt > HAIKU_LONG_AT ? PRICE_HAIKU_LONG : PRICE_HAIKU
  return { in: i, w5: i * 1.25, w1h: i * 2, read: i * 0.1, out: o }
}

/** The rows of a JSONL transcript; a line that does not parse (cut by a read from the end, half written) is left out. */
export function recordRows(text) {
  const rows = []
  for (const line of String(text ?? '').split('\n')) {
    const t = line.trim()
    if (t === '') continue
    try {
      const d = JSON.parse(t)
      if (d !== null && typeof d === 'object' && !Array.isArray(d)) rows.push(d)
    } catch {}
  }
  return rows
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const messageOf = (d) => (isObject(d.message) ? d.message : {})

/**
 * The model requests of a transcript in order. One response is kept as a row per content block, all with
 * its usage: they are merged by message id. `before` lists what reached the model since the last request:
 * ['result', tool_use_id] or ['text', text].
 */
export function requestsOf(rows) {
  const reqs = []
  const index = new Map()
  let pending = []
  rows.forEach((d, pos) => {
    const m = messageOf(d)
    if (d.type === 'user') {
      if (typeof m.content === 'string') pending.push(['text', m.content])
      else if (Array.isArray(m.content)) {
        for (const b of m.content) {
          if (isObject(b) && b.type === 'tool_result') pending.push(['result', b.tool_use_id])
          else if (isObject(b) && b.type === 'text') pending.push(['text', b.text ?? ''])
        }
      }
    }
    if (d.type === 'assistant' && m.usage) {
      let r = index.get(m.id)
      if (r === undefined) {
        const u = m.usage
        const cc = isObject(u.cache_creation) ? u.cache_creation : {}
        r = {
          id: m.id, pos, time: d.timestamp ?? null, model: m.model,
          in: u.input_tokens || 0, w: u.cache_creation_input_tokens || 0, w1h: cc.ephemeral_1h_input_tokens || 0,
          read: u.cache_read_input_tokens || 0, out: u.output_tokens || 0, tools: [], stop: null, before: pending,
        }
        r.prompt = r.in + r.w + r.read
        r.new = r.in + r.w
        index.set(m.id, r)
        reqs.push(r)
        pending = []
      }
      r.stop = m.stop_reason || r.stop
      for (const b of Array.isArray(m.content) ? m.content : []) {
        if (isObject(b) && b.type === 'tool_use') r.tools.push([b.name, b.id])
      }
    }
  })
  return reqs
}

/** A value as Python's json.dumps(ensure_ascii=False) writes it (the script measures tool inputs so). */
function pyDumps(v) {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : JSON.stringify(v)
  if (Array.isArray(v)) return '[' + v.map(pyDumps).join(', ') + ']'
  return '{' + Object.entries(v).map(([k, x]) => JSON.stringify(k) + ': ' + pyDumps(x)).join(', ') + '}'
}

const codePoints = (s) => [...String(s)].length // Python's len

function resultText(b) {
  if (typeof b.content === 'string') return b.content
  if (Array.isArray(b.content)) return b.content.map((x) => (isObject(x) && typeof x.text === 'string' ? x.text : '')).join('')
  return ''
}

/** Writes of `tokens` to the cache, the 1-hour share at its price and the rest at the 5-minute one. */
const costNew = (tokens, share1h, p) => (tokens * (share1h * p.w1h + (1 - share1h) * p.w5)) / PER_M

/** What a subagent's requests cost at claude-haiku-5-5 prices. */
export function childCost(reqs) {
  let total = 0
  for (const r of reqs) {
    const p = haikuPrice(r.prompt)
    total += (r.in * p.in + (r.w - r.w1h) * p.w5 + r.w1h * p.w1h + r.read * p.read + r.out * p.out) / PER_M
  }
  return total
}

/** The steps the main loop would take for a subagent: up to its first answer (no tool, or only the hand-back). */
function replaySteps(reqs) {
  const steps = []
  for (const r of reqs) {
    steps.push(r)
    if (r.tools.length === 0 || r.tools.every(([n]) => n === HANDBACK_TOOL)) return { steps, answered: true }
  }
  return { steps, answered: false }
}

/** The probe calls of the main-loop request that made the call `id`, or undefined while it is not in the rows. */
export function probeGroupOf(prows, id) {
  const r = requestsOf(prows).find((x) => x.tools.some(([, t]) => t === id))
  return r === undefined ? undefined : r.tools.filter(([n]) => n === PROBE_TOOL).map(([, t]) => t)
}

/**
 * The estimate for the probe calls `ids` of one main-loop request, given the rows of the main loop's
 * transcript and of each of their subagents' (kidRows), as the trial script computes it:
 *   saved: 1a the context C read again by the K-1 requests more, 1b what the work added to it, read again,
 *          2 what the work wrote to the cache, 4 the main loop's output (the subagent's stands in for it);
 *   spent: 1 the output of the request that called probe, 2 the subagents, 3 the answer written to the cache.
 * status: 'ok', 'pending' (the request after the result is not in the rows yet), 'interrupted' (the result
 * never reached the main loop), 'no-children', 'missing' (the call is not in the rows).
 */
export function savingsOf(prows, ids, kidRows) {
  const preqs = requestsOf(prows)
  const input = new Map()
  const result = new Map()
  for (const d of prows) {
    const m = messageOf(d)
    if (!Array.isArray(m.content)) continue
    for (const b of m.content) {
      if (!isObject(b)) continue
      if (d.type === 'assistant' && b.type === 'tool_use') input.set(b.id, b.input || {})
      if (d.type === 'user' && b.type === 'tool_result' && !result.has(b.tool_use_id)) result.set(b.tool_use_id, resultText(b))
    }
  }
  const written = preqs.reduce((s, r) => s + r.w, 0) || 1
  const share1h = preqs.reduce((s, r) => s + r.w1h, 0) / written
  const i = preqs.findIndex((x) => x.tools.some(([, t]) => ids.includes(t)))
  if (i < 0) return { status: 'missing' }
  const r = preqs[i]
  const group = r.tools.filter(([n]) => n === PROBE_TOOL).map(([, t]) => t)
  const others = r.tools.filter(([n]) => n !== PROBE_TOOL).map(([, t]) => t)
  const size = (t) => codePoints(pyDumps(input.get(t) ?? {}))
  const sum = (ts, f) => ts.reduce((s, t) => s + f(t), 0)
  const shareOut = sum(group, size) / (sum([...group, ...others], size) || 1)
  const res = (t) => codePoints(result.get(t) ?? '')
  const shareRes = sum(group, res) / (sum([...group, ...others], res) || 1)
  const kids = kidRows.map(requestsOf)
  if (kids.length === 0) return { status: 'no-children' }
  if (group.some((t) => (result.get(t) ?? '').startsWith('[Tool call interrupted'))) return { status: 'interrupted' }
  const next = preqs.slice(i + 1).find((x) => x.before.some(([k, v]) => k === 'result' && group.includes(v)))
  if (next === undefined) return { status: 'pending' }
  const C = r.prompt
  let K = 0
  let save1b = 0
  let save2 = 0
  let save4 = 0
  for (const reqs of kids) {
    if (reqs.length === 0) continue // no request recorded: nothing to replay (the script stops here)
    const { steps, answered } = replaySteps(reqs)
    const c1 = steps[0].prompt
    const calling = answered ? steps.slice(0, -1) : steps
    K += calling.length
    for (const s of steps.slice(1)) {
      save1b += (Math.max(s.prompt - c1 - s.new, 0) * PRICE_OPUS.read) / PER_M
      save2 += costNew(s.new, share1h, PRICE_OPUS)
    }
    save4 += (calling.reduce((n, s) => n + s.out, 0) * PRICE_OPUS.out) / PER_M
  }
  const save1a = (Math.max(K - 1, 0) * C * PRICE_OPUS.read) / PER_M
  const add1 = (r.out * shareOut * PRICE_OPUS.out) / PER_M
  const add2 = kids.reduce((s, reqs) => s + childCost(reqs), 0)
  const add3 = costNew(next.new * shareRes, share1h, PRICE_OPUS)
  const net = save1a + save1b + save2 + save4 - add1 - add2 - add3
  return { status: 'ok', C, K, save1a, save1b, save2, save4, add1, add2, add3, net }
}

/**
 * The line shown under a probe call: the saving in dollars, and as a share of what the main loop would have
 * paid without probe (the saved parts, 1a + 1b + 2 + 4; what both ways pay alike is in neither). Without
 * saved parts (no tool step to replay) there is no share to give.
 */
export function savingsLine(s) {
  const without = s.save1a + s.save1b + s.save2 + s.save4
  const line = `推定節約${s.net.toFixed(2)}$(API相当)`
  return without > 0 ? `${line}　Probe未使用と比較し${Math.round((s.net / without) * 100)}%削減` : line
}

const callChildren = new Map() // tool_use_id of a main-loop probe call -> its subagents' ids
const savingsPending = new Map() // tool_use_id -> estimates left to try
let sessionDir // [session id, the directory its transcript is in]

/** The directory under the config's projects/ that holds this session's transcript. */
async function sessionDirOf($, sid) {
  if (sessionDir && sessionDir[0] === sid) return sessionDir[1]
  const config = (await $.env.get('CLAUDE_CONFIG_DIR')) || `${await $.env.get('HOME')}/.claude`
  const projects = `${config}/projects`
  for (const entry of await $.fs.list(projects)) {
    if (entry.kind === 'file') continue // 'dir', or 'other' for a link to one
    if (await $.fs.exists(`${projects}/${entry.name}/${sid}.jsonl`)) {
      sessionDir = [sid, `${projects}/${entry.name}`]
      return sessionDir[1]
    }
  }
  return undefined
}

/** A transcript's text; over what $.fs.read takes, its last part (the calls looked for are the latest). */
async function readTranscript($, path) {
  const { size } = await $.fs.stat(path)
  if (size <= TRANSCRIPT_READ_MAX) return String(await $.fs.read(path))
  const r = await $.process.run(['tail', '-c', String(TRANSCRIPT_READ_MAX), path], { timeoutMs: 10000 })
  if (r.exitCode !== 0) throw new Error(`tail: ${r.stderr}`)
  return r.stdout
}

/** Shows the line of each main-loop probe call whose estimate can be made now; the rest wait (a few tries). */
async function showSavings($) {
  if (savingsPending.size === 0) return
  const sid = await $.session.id()
  const dir = await sessionDirOf($, sid)
  if (dir === undefined) {
    await traceLine($, { hook: 'savings', error: `no transcript directory for session ${sid}`, pending: [...savingsPending.keys()] })
    savingsPending.clear()
    return
  }
  const prows = recordRows(await readTranscript($, `${dir}/${sid}.jsonl`))
  for (const [id, left] of [...savingsPending]) {
    if (!savingsPending.has(id)) continue // shown with another call of its request
    const ids = probeGroupOf(prows, id) ?? [id]
    const kidRows = []
    for (const agentId of ids.flatMap((t) => callChildren.get(t) ?? [])) {
      try {
        kidRows.push(recordRows(await $.fs.read(`${dir}/${sid}/subagents/agent-${agentId}.jsonl`)))
      } catch {
        kidRows.push([])
      }
    }
    const s = savingsOf(prows, ids, kidRows)
    await traceLine($, { hook: 'savings', ids, children: kidRows.map((k) => k.length), rows: prows.length, status: s.status, net: s.net, left })
    if (s.status === 'pending' || s.status === 'missing') {
      if (left <= 1) savingsPending.delete(id)
      else savingsPending.set(id, left - 1)
      continue
    }
    for (const t of ids) savingsPending.delete(t)
    if (s.status === 'ok') {
      // Calls of one request share one estimate: on the row of the last of them, with how many it covers.
      const line = savingsLine(s) + (ids.length > 1 ? `（probe ${ids.length} 件分）` : '')
      await update($, memberOf(savingsShown, { requestId: ids[ids.length - 1] }), () => line)
    }
  }
}

async function trySavings($) {
  try {
    await showSavings($)
  } catch (err) {
    await traceLine($, { hook: 'savings', error: String(err && err.message ? err.message : err), pending: [...savingsPending.keys()] })
    savingsPending.clear() // the files cannot be read here: no estimate this time
  }
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

  // The rules for using probe go after the model attachment of the main conversation and of each subagent but
  // a probe subagent (see the header), in place of any an older probe stored in it. An attachment another
  // hook left out stays out; a mode with no rules leaves none; a failure leaves the attachment as it came.
  on('prompt.attachment', { type: USAGE_ATTACHMENT }, async ($, e, next) => {
    const r = await next(e)
    if (typeof r.text !== 'string') return r
    const text = withoutStoredUsage(r.text)
    const usage = e.agentId !== undefined && (await isProbeAgent($, e.agentId)) ? null : await usageOf($)
    return { text: usage ? withUsage(text, usage) : text }
  }).catch(($, e, next) => next(e))

  on('command.run', { command: MODE_COMMAND }, ($, e) => switchSetting($, MODE_SETTING, e.args)).catch(($, e, next) => next(e))

  // A probe call's effort, on each model request of the children it started (a spawn takes no effort).
  on('turn.step', async function* ($, e, next) {
    const effort = e.agentId === undefined ? undefined : childCalls.get(e.agentId)?.effort
    const step = yield* next(effort === undefined || effort === e.effort ? e : { ...e, effort })
    // A main-loop request is done: a probe call before it may have its savings line now.
    if (e.agentId === undefined && savingsPending.size > 0) await trySavings($)
    return step
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
      return next(e)
    }
    const r = await next(e)
    if (savingsPending.size > 0) await trySavings($) // the turn's last request is in the transcript by now
    return r
  })

  // A probe call's row: as the engine draws it, and under it the call's savings line once there is one.
  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    if (e.props.tool !== PROBE_TOOL) return next(e)
    const line = await read($, memberOf(savingsShown, e))
    const row = await next(e)
    if (!line) return row
    const { Box, Text } = $.ui.resolve(e)
    return h(Box, { flexDirection: 'column' }, row, h(Text, { dimColor: true }, line))
  })

  on('tool.call', { tool: PROBE_TOOL }, async ($, e, next) => {
    const result = await runProbe($, e, next.signal)
    // Its savings line waits for the main loop's request after the result (the answer it writes counts).
    await traceLine($, { hook: 'savings', call: e.tool_use_id ?? null, agentId: e.agentId ?? null, children: callChildren.get(e.tool_use_id) ?? [] })
    if (e.agentId === undefined && typeof e.tool_use_id === 'string') {
      savingsPending.set(e.tool_use_id, SAVINGS_TRIES)
      while (savingsPending.size > SAVINGS_CAP) savingsPending.delete(savingsPending.keys().next().value)
    }
    return result
  }).catch(($, e, next) => ({ deny: failureText(next.error) }))

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
    if (!box) return next(e) // no sandbox: the tool.check below
    return next({ ...e, command: box.wrap(e.command, stopSeconds(e.timeout, await bashDefaultMs($))) })
  }).catch(($, e, next) => {
    if (next.called) return next(e)
    if (e.agentId === undefined) return next(e)
    if (probeAgents.has(e.agentId) || (activeRuns > 0 && !otherAgents.has(e.agentId))) {
      return { deny: GATE_FAIL_DENY }
    }
    return next(e)
  })

  // Innermost: a probe subagent asked for its answer so far (past its time) may call no tool but the
  // hand-back that carries the answer. The context tool answers above this, so it refuses itself. A
  // throw in `next` reaches the catch, whose `next` replays what it settled to (nothing runs twice).
  on('tool.call', async ($, e, next) => (wrappingUp(e) ? { deny: WRAPUP_DENY } : next(e))).catch(($, e, next) => next(e))

  // No sandbox here: a probe subagent's Bash runs only when Bash itself finds the command read-only.
  // In the sandbox: auto mode reviews the call as the model wrote it, so the wrapped one gets no verdict and is
  // put to the person. Such an ask is allowed: the sandbox neither writes nor sends. A deny stays a deny.
  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    if (e.agentId === undefined || e.isReadOnly === true || !(await isProbeAgent($, e.agentId))) return next(e)
    if (await sandboxOff($)) return next(e)
    if ((await sandboxOf($, e.agentId)) !== null) {
      const r = await next(e)
      return r && r.decision === 'ask' ? { decision: 'allow', reason: SANDBOXED_ALLOW } : r
    }
    return { decision: 'deny', reason: NO_SANDBOX_DENY }
  }).catch(($, e, next) => (e.agentId !== undefined && probeAgents.has(e.agentId) ? { decision: 'deny', reason: NO_SANDBOX_DENY } : next(e)))

  // The probe tool's result already carries the subagent's answer: do not let what the
  // subagent sends its parent put the same text into the parent's context a second time.
  // (1) its SubagentHandback report. The tool queues it for the parent as a peer message
  //     (not through session.send); a running turn receives it as a `queued_command`
  //     attachment (a "Another Claude session sent a message while you were working"
  //     reminder), an idle session takes it from the queue as a prompt.
  //     In the running turn: prompt.attachment leaves it out of the request. The row is stored first
  //     (session.append below cuts it to a stub) and a request carries it as stored, so the stub is
  //     what this hook sees: it leaves that out too, and so the cut task-notification of (2).
  // Debugging aid: what every attachment that looks like a delivery holds, as it is about to be sent.
  on('prompt.attachment', async ($, e, next) => {
    await trace($, 'prompt.attachment (any)', e, undefined)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('prompt.attachment', { type: 'queued_command' }, async ($, e, next) => {
    const senders = handbackSendersOf(e.text)
    const drop = onlyStubs(e.text) || (senders !== undefined && (await allProbeSenders($, senders)))
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

  //     For either path: a row cannot be refused at session.append, but its text can be replaced
  //     by a one-line stub (which prompt.attachment above then leaves out).
  on('session.append', { origin: { kind: ['peer', 'coordinator', 'unclassified', 'task-notification'] } }, cutRow).catch(($, e, next) => next(e))
  on('session.append', { door: ['attachment', 'delivery'] }, cutRow).catch(($, e, next) => next(e))

  // (2) its task-notification: an idle session's is dropped here; one delivered into a running turn is
  //     cut by session.append above and its stub left out by prompt.attachment.
  on('prompt.submit', { origin: { kind: 'task-notification' } }, async ($, e, next) => {
    if (!(await probeNotification($, e.text))) return next(e)
    return { drop: 'probe: probe の完了通知は tool の結果に含まれている' }
  }).catch(($, e, next) => next(e))
}
