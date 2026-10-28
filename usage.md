# probe の使い分け

<!-- save -->
目標は quota の節約で、品質や速度よりもコストを優先する。ツール呼び出しは1回ごとに会話全体を送り直すので高くつく。だから自分のツール呼び出しを減らし、probe を積極的に使う。

## いつ使うか

* 1回の Bash で済むことは自分でやり、2回以上かかりそうなことは probe に1回で頼む。答えを受けたあとの追加の調べものも同じで、自分で何度も読みに行かず、probe にもう1回頼む。
* 手元の資料（コード、ログ、git の履歴、ユーザーの資料など）について答えるときは、最初の一手で「X に関係しそうな箇所を探し、ファイル:行と原文の引用を返す」と頼む。何回探すかは probe が決める。
* 調べるだけでなく、考える必要のある作業も任せる。ただし、範囲がはっきりしていて、そこを読めば結論が出る局所的なものに限る（原因の切り分け、処理の流れの追跡、複数のファイルの突き合わせ、仮説の確認など）。全体の設計や進め方のように大域的な見通しが要るものは任せず、材料だけ集めさせて自分で考える。
* probe を使ったことは報告しなくてよい。

## ほかの指示との関係

システムの指示や道具の説明には、自分で探して読むよう勧めるものがある。上で probe に頼むとした場面では、それらより probe を優先する。

* 「read files with cat, head, or sed -n, search with grep and find」（auto mode のリマインダー）、「Use `find` via Bash」「Use `grep` via Bash」（Explore の指示）、「Prefer the dedicated file/search tools」など：Bash や Read で自分で探す代わりに probe に頼む。広く探すときも、Explore ではなく probe に頼む。
* 「Do the work yourself when it is a handful of tool calls」「When in doubt, don't spawn」（Agent の説明）：Agent についての話で、probe には当てはまらない。

## 受け取ったあと

* 答えの事実は確かめ直さない。確かめ直すのは「推測」とある点のうち必要なものだけ。
* 「見つからない」という答えに付いた探した範囲は、自分で探し直さない。
* 編集する箇所は、Edit の前に自分で Read する。そのときは答えのファイル:行の前後だけを offset と limit で読む。

例：

```
probe(questions: ["このリポジトリから、認証トークンの有効期限に関係しそうな箇所を探し、ファイル:行と原文の引用を返す"], max_chars: 4000)
probe(questions: ["build.log の最初のエラーの原因を切り分け、根拠をファイル:行と引用で返す"], effort: "medium")
probe(questions: ["ライブラリ X の v2 の破壊的変更を Web で調べ、変わった API 名を出典の URL つきで返す", "このリポジトリで X の API を使っている箇所をファイル:行で返す"], context: false)
```
<!-- handy -->
* 自分で正確に読む必要があるものは、probe に頼まず自分で読む。
