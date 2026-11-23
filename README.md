# hidden-spec-cli-01

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rayhanbhuiyan01/hidden-spec-cli-01/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/rayhanbhuiyan01/hidden-spec-cli-01/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line patch tool for every AI edit format: it applies unified diffs (even with wrong line numbers), SEARCH/REPLACE blocks, V4A patches and JSON tool calls to a tree of files. It finds the lines an edit names even when the model drifted their whitespace or indentation, matching at three tiers, and changes every file or none. Node 22, standard library only.

## Run it

```sh
node main.ts [PATCH]
```

`main.ts` is the CLI: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`, where PATCH is a patch file or `-` / absent for standard input. `--format` is `auto` (the default, which detects the format), `unified`, `search-replace`, `v4a` or `json`; `--check` reports what would change without writing; `--strict` matches lines exactly. `runner.ts` beside it is the kit's runner, unchanged.

---

Entered on [make.fun](https://make.fun/?ref=r3j4cz5h&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards
