# probe

Claude Code の調べものを Haiku に任せて、Claude 本体の quota を節約するプラグイン。Claude 本体は問いを渡すだけで、結論と根拠の引用が返ってくる。

サブエージェントと違ってファイルは変更できないが、依頼文を書かずに問いだけで呼べ、答えはその場で返る。

## 役に立つこと

- **quota の節約**：Claude 本体はツールを呼ぶたびに会話全体を送り直す。probe なら、何回分もの探す・読む手順を Haiku が受け持ち、本体の呼び出しは1回で済む。
- **会話の見通し**：ログや検索結果は Haiku が読み、本体の会話には結論とファイル:行つきの引用だけが残る。
- **ファイルの保護**：Haiku は読み取り専用の環境で動くので、テストやスクリプトを任せてもファイルは変わらない。
- **サブエージェントでの利用**：サブエージェントも probe を使う。

## 導入

### 1. 前提

- **Claude Code**：2.1.310 で確かめた。mod の API は early access なので、ほかの版では動かないことがある。
- **auto mode**：manual モードでは Haiku のコマンドが断られる。
- **OS のサンドボックス**：ないと、Haiku は読むだけのコマンドしか実行できない。
  - Linux：bubblewrap（`sudo apt install bubblewrap` など）。`bwrap --ro-bind / / --dev /dev --proc /proc true && echo OK` で OK と出れば使える。
  - macOS：標準の `sandbox-exec`（未確認）。
  - Windows：`claude sandbox install` と、PATH 上の `srt`（未確認）。

### 2. インストール

```sh
claude plugin marketplace add NakamuraTakumu/Claude-Probe-Plugin
claude plugin install probe@probe
```

Claude Code を起動中なら、起動し直す。

### 3. 確認

- `/probe-mode` で「今は handy」と出れば、入っている。
- 「probe で `python3 -c 'print(6*7)'` を実行して」と頼んで 42 が返れば、コマンドも動いている。

## モード

`/probe-mode save` か `/probe-mode handy` で切り替える。選んだモードは、後のセッションにもサブエージェントにも効く。

- **handy**（既定）：広く探すとき、長い出力から要点だけ欲しいとき、Web で調べるときに使う。
- **save**：quota を優先する。2回以上の呼び出しがかかる調べものは probe に任せ、答えを確かめ直さない。方針の全文は [usage.md](usage.md)。

## 制限

- 答えは日本語で返る。
- Haiku の取りこぼしや読み違いがありうる。確かめていない点には「推測」と付く。
- 1つの問いは15分で打ち切られる。

## 開発

`claude plugin validate .` と `claude plugin test .` で検査する（モデルは呼ばない）。実装の説明は [docs/design.md](docs/design.md)。

## ライセンス

MIT（[LICENSE](LICENSE)）
