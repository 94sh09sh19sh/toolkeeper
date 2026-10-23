# toolkeeper

管理自製的 Claude Code 工具（hook、skill、狀態列）：一份 repo 原始碼、一份實際執行的部署、一份 GitHub 公開版，三者用同一套規則同步，不再手動複製。

## 摘要
- 方向只有一個：**改 repo → `deploy` 到執行端**。執行端被直接改過時 `deploy` 會拒絕，避免兩邊各改各的。
- 執行端只放跑得動所需的檔案（不含 README、測試、repo 設定），hook 註冊到 `settings.json` 也由 `deploy` 處理。
- 設定與特例分三層：repo 預設（公開）、執行端 `*.local.*`（個人，部署不覆蓋）、專案的 `.claude/`（專案特例，跟著專案走）。
- `check` 掃本機使用者名稱、email、金鑰與你的私人詞清單；`deploy` 會在每個工具 repo 裝 pre-push hook，推上 GitHub 前自動檢查。
- 新工具用 `new` 建立，之後跟現有工具同一套流程。

## 為什麼是 repo → 執行端
- repo 有 git 歷史，改壞了能回復；執行端沒有。
- 公開檢查與 pre-push 把關都在 repo 這一側，從這裡出發才不會把個人內容帶進公開版。
- 執行端混有狀態檔與本機設定，反方向同步很容易把它們誤帶回 repo。
- 執行端不小心被直接改了（例如 session 裡順手改 hook）：`deploy` 會中止並列出檔案，用 `diff` 看差異，要保留就搬回 repo，不要就 `--force`（先備份再覆蓋）。

## 資料夾配置
- 工具 repo：`<repoRoot>/<名稱>/`，每個工具一個 git repo，根目錄放 `deploy.json`。
- 執行端：`~/.claude/<target>/`，`target` 寫在 `deploy.json`。
- toolkeeper 本機資料：`~/.claude/toolkeeper/`
  - `config.local.json`：`repoRoot`（第一次從 repo 執行 `deploy toolkeeper` 時自動寫入）。
  - `private-terms.local.txt`：私人詞清單，一行一個，`#` 開頭是註解；公開檢查會擋這些詞。
  - `state/deployed.json`：每個工具上次部署的檔案雜湊、commit、註冊的 hook。
  - `state/backup/`、`state/settings-backup/`：覆蓋或刪除前的備份。

## deploy.json
```json
{
  "target": "my-tool",
  "hooks": [
    { "event": "PreToolUse", "matcher": "Write|Edit", "script": "hook.js", "timeout": 10, "statusMessage": "檢查中" }
  ],
  "statusLine": "statusline.js",
  "exclude": ["docs/"],
  "keep": ["cache/"],
  "test": "node test.js"
}
```
- `target`：部署到 `~/.claude/` 底下的相對路徑；skill 用 `skills/<名稱>`。
- `hooks`：要註冊的 hook；`command` 由 `script` 自動組成 `node <執行端絕對路徑>`。
- `statusLine`：狀態列腳本；已被別的工具占用時不覆蓋，除非 `--force`。
- `exclude`：額外不部署的檔案。預設已排除 `.git/`、`.gitignore`、`README*`、`LICENSE*`、`CHANGELOG*`、`deploy.json`、`test/`、`tests/`、`node_modules/`、`state/`、`*.local.*`。
- `keep`：額外的執行端專有路徑，部署永遠不碰。預設是 `state/` 與 `*.local.*`。
- `test`：部署前在 repo 裡執行的指令，失敗就不部署。所有 `.js` 也會先跑 `node --check`。

## 指令
- `node ~/.claude/toolkeeper/cli.js status`：每個工具的 repo 狀態、執行端是否同步、缺哪些 hook 註冊、本機特例檔行數、公開檢查結果。
- `deploy <名稱|all> [--dry-run] [--force] [--prune]`：repo → 執行端。`--dry-run` 只列變更；`--force` 覆蓋被直接改過的檔；`--prune` 刪掉執行端來路不明的檔（都會先備份）。
- `diff <名稱>`：執行端與 repo 的差異（`-` 是執行端，`+` 是 repo）。
- `check <名稱|all> [--history]`：公開檢查工作目錄；`--history` 改掃整個 git 歷史。確定可公開的行加上註解 `toolkeeper: allow`。
- `new <名稱> [--skill]`：建立新工具 repo（README、deploy.json、.gitignore、pre-push hook）。
- `remove <名稱> [--purge]`：從執行端移除並取消 settings 註冊；`--purge` 連狀態與本機設定一起刪。

## 日常流程
1. 在 repo 改程式。
2. `deploy <名稱>` 試用（可以部署未提交的改動，`status` 會標出來）。
3. 沒問題就 commit、push；pre-push 會跑 `check`，有個人內容就擋下。
4. 專案特例不要寫進工具：放專案的 `.claude/`，或執行端的 `*.local.*`。

## 第一次使用
1. 把 toolkeeper 跟其他工具 repo 放在同一個資料夾，例如 `~/tools/toolkeeper`。
2. 每個工具 repo 加 `deploy.json`。
3. 從 repo 執行 `node ~/tools/toolkeeper/cli.js deploy toolkeeper`，之後都用 `~/.claude/toolkeeper/cli.js`。
4. 先 `status` 看狀況，再 `deploy all --dry-run` 確認。

## 已知限制
- 只支援 Node.js 腳本的 hook（`command` 固定是 `node <路徑>`）。
- `settings.json` 只增改這個工具註冊過的 hook，不會動其他設定；改之前會備份，解析失敗就不動。
- 私人詞比對不分大小寫、純字串比對。
- pre-push 需要 Git for Windows 或其他有 `sh` 的 git。
