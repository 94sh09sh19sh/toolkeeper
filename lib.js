// toolkeeper 共用函式：路徑、清單、檔案比對、部署紀錄、settings.json 註冊、公開檢查
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

const slash = (p) => String(p).split('\\').join('/');
// CLAUDE_CONFIG_DIR 可以把整套指到別的資料夾（測試用）
const CLAUDE = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
// 本機設定與部署紀錄固定放這裡，不論從 repo 還是執行端執行都讀同一份
const HOME = path.join(CLAUDE, 'toolkeeper');
const STATE = path.join(HOME, 'state');
const LOCK_FILE = path.join(STATE, 'deployed.json');
const LOCAL_CONFIG = path.join(HOME, 'config.local.json');
const TERMS_FILE = path.join(HOME, 'private-terms.local.txt');
const SETTINGS = path.join(CLAUDE, 'settings.json');

// 不部署到執行端的檔案：說明文件、repo 設定、測試；執行端用不到，只會佔空間
const DEFAULT_EXCLUDE = ['.git/', '.gitignore', '.gitattributes', 'README*', 'LICENSE*', 'CHANGELOG*', 'deploy.json', 'test/', 'tests/', 'node_modules/', 'state/', '*.local.*'];
// 執行端專有、部署永遠不碰的檔案：執行狀態與本機設定
const DEFAULT_KEEP = ['state/', '*.local.*'];

function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return fallback;
  }
}

// 先寫暫存檔再改名，避免寫到一半被讀到
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  return { ok: r.status === 0, out: r.stdout || '', err: r.stderr || '' };
}

const hashFile = (file) => crypto.createHash('sha1').update(fs.readFileSync(file)).digest('hex');

// 簡化版 glob：沒有 / 的樣式比對任何深度的檔名；結尾 / 表示整個資料夾
function globRe(p) {
  const dir = p.endsWith('/');
  const body = dir ? p.slice(0, -1) : p;
  const re = body
    .split('**')
    .map((s) => s.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]'))
    .join('.*');
  return new RegExp(`${body.includes('/') ? '^' : '(^|/)'}${re}${dir ? '(/|$)' : '$'}`, 'i');
}

const matchAny = (res, rel) => res.some((r) => r.test(rel));

// 列出資料夾底下所有檔案（相對路徑，用 /）
function walk(dir, base = dir) {
  let out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== '.git') out = out.concat(walk(p, base));
    } else if (e.isFile()) out.push(slash(path.relative(base, p)));
  }
  return out;
}

// repo 裡要算進來的檔案：已追蹤＋未追蹤但沒被 .gitignore 排除的（工作目錄現況）
function repoFiles(dir) {
  const r = git(dir, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']);
  const files = r.ok ? r.out.split('\0').filter(Boolean) : walk(dir);
  return [...new Set(files.map(slash))].filter((f) => {
    try {
      return fs.statSync(path.join(dir, f)).isFile();
    } catch {
      return false;
    }
  });
}

function loadLocalConfig() {
  return readJson(LOCAL_CONFIG, {});
}

// 工具 repo 的上層資料夾：本機設定優先；第一次從 repo 直接執行時用自己所在 repo 的上一層
function repoRoot() {
  const cfg = loadLocalConfig();
  if (cfg.repoRoot) return path.resolve(cfg.repoRoot);
  if (fs.existsSync(path.join(__dirname, '.git'))) return path.dirname(__dirname);
  return null;
}

function listTools(root) {
  try {
    return fs
      .readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory() && fs.existsSync(path.join(root, e.name, 'deploy.json')))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

function loadTool(root, name) {
  const dir = path.join(root, name);
  const manifest = readJson(path.join(dir, 'deploy.json'));
  if (!manifest) throw new Error(`${name} 沒有 deploy.json 或格式錯誤`);
  const rel = slash(manifest.target || name).replace(/^\/+|\/+$/g, '');
  if (!rel || rel.split('/').includes('..') || path.isAbsolute(rel)) throw new Error(`${name} 的 target 必須是 ~/.claude 底下的相對路徑`);
  return { name, dir, manifest, targetRel: rel, target: path.join(CLAUDE, rel) };
}

function loadLock() {
  const lock = readJson(LOCK_FILE, {});
  lock.tools = lock.tools || {};
  return lock;
}

const saveLock = (lock) => writeJson(LOCK_FILE, lock);

function sourceFiles(tool) {
  const ex = [...DEFAULT_EXCLUDE, ...(tool.manifest.exclude || [])].map(globRe);
  const src = {};
  for (const rel of repoFiles(tool.dir)) if (!matchAny(ex, rel)) src[rel] = hashFile(path.join(tool.dir, rel));
  return src;
}

function runtimeFiles(tool) {
  const keep = [...DEFAULT_KEEP, ...(tool.manifest.keep || [])].map(globRe);
  const out = {};
  for (const rel of walk(tool.target)) if (!matchAny(keep, rel)) out[rel] = hashFile(path.join(tool.target, rel));
  return out;
}

// 比對 repo、執行端、上次部署紀錄，算出要複製、要刪除、被直接改過、來路不明的檔案
function plan(tool, lock) {
  const src = sourceFiles(tool);
  const run = runtimeFiles(tool);
  const prev = lock.tools[tool.name];
  const managed = prev && prev.target === tool.targetRel ? prev.files : null;
  const copy = Object.keys(src).filter((rel) => run[rel] !== src[rel]);
  const remove = [];
  const drift = [];
  const unmanaged = [];
  if (managed) {
    for (const [rel, h] of Object.entries(managed)) {
      if (run[rel] === undefined) {
        if (src[rel]) drift.push({ rel, kind: '被刪掉' });
      } else {
        if (run[rel] !== h) drift.push({ rel, kind: '被改過' });
        if (!src[rel]) remove.push(rel);
      }
    }
    for (const rel of Object.keys(run)) {
      if (managed[rel]) continue;
      if (!src[rel]) unmanaged.push(rel);
      else if (run[rel] !== src[rel]) drift.push({ rel, kind: '被新增' });
    }
  } else {
    // 沒有部署紀錄：執行端跟 repo 內容不同的檔，都可能是直接改過的
    for (const rel of Object.keys(run)) {
      if (!src[rel]) unmanaged.push(rel);
      else if (run[rel] !== src[rel]) drift.push({ rel, kind: '跟 repo 不同' });
    }
  }
  return { src, run, copy, remove, drift, unmanaged, prev };
}

// 刪掉檔案後，往上清掉變空的資料夾（不刪到 stop 本身）
function removeEmptyDirs(start, stop) {
  let dir = start;
  while (path.resolve(dir).length > path.resolve(stop).length) {
    try {
      if (fs.readdirSync(dir).length) return;
      fs.rmdirSync(dir);
    } catch {
      return;
    }
    dir = path.dirname(dir);
  }
}

function repoState(dir) {
  const head = git(dir, ['rev-parse', '--short', 'HEAD']);
  const st = git(dir, ['status', '--porcelain', '-b']);
  if (!st.ok) return { git: false };
  const lines = st.out.split('\n').filter(Boolean);
  const header = lines[0] || '';
  const ahead = Number((header.match(/ahead (\d+)/) || [])[1] || 0);
  const behind = Number((header.match(/behind (\d+)/) || [])[1] || 0);
  return { git: true, commit: head.ok ? head.out.trim() : null, dirty: lines.length - 1, upstream: header.includes('...'), ahead, behind };
}

// ---------- settings.json 註冊 ----------

const norm = (c) => slash(c).toLowerCase().replace(/\s+/g, ' ').trim();

function hookCommand(tool, script) {
  return `node ${slash(path.join(tool.target, script))}`;
}

function wantedHooks(tool) {
  return (tool.manifest.hooks || []).map((h) => ({
    event: h.event,
    matcher: h.matcher || '',
    entry: {
      type: 'command',
      command: hookCommand(tool, h.script),
      ...(h.timeout ? { timeout: h.timeout } : {}),
      ...(h.statusMessage ? { statusMessage: h.statusMessage } : {}),
      ...(h.async ? { async: true } : {}),
      ...(h.asyncRewake ? { asyncRewake: true } : {}),
    },
  }));
}

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  // 解析失敗時直接丟錯，絕不覆寫使用者的 settings.json
  return JSON.parse(fs.readFileSync(SETTINGS, 'utf8').replace(/^\uFEFF/, ''));
}

function findHook(settings, event, command) {
  for (const g of settings.hooks?.[event] || []) {
    for (const h of g.hooks || []) if (norm(h.command || '') === norm(command)) return { g, h };
  }
  return null;
}

function removeHook(settings, event, command) {
  const groups = settings.hooks?.[event];
  if (!groups) return false;
  let hit = false;
  for (const g of groups) {
    const before = (g.hooks || []).length;
    g.hooks = (g.hooks || []).filter((h) => norm(h.command || '') !== norm(command));
    if (g.hooks.length !== before) hit = true;
  }
  settings.hooks[event] = groups.filter((g) => g.hooks.length);
  if (!settings.hooks[event].length) delete settings.hooks[event];
  return hit;
}

// 把工具的 hook 與狀態列同步進 settings.json；回傳變更說明（dry 時只算不寫）
function syncSettings(tool, prev, { dry = false, force = false } = {}) {
  const s = readSettings();
  s.hooks = s.hooks || {};
  const want = wantedHooks(tool);
  const changes = [];
  const warnings = [];
  for (const o of prev?.hooks || []) {
    if (want.some((w) => w.event === o.event && norm(w.entry.command) === norm(o.command))) continue;
    if (removeHook(s, o.event, o.command)) changes.push(`移除 ${o.event} hook：${o.command}`);
  }
  for (const w of want) {
    const found = findHook(s, w.event, w.entry.command);
    if (!found) {
      (s.hooks[w.event] = s.hooks[w.event] || []).push({ ...(w.matcher ? { matcher: w.matcher } : {}), hooks: [w.entry] });
      changes.push(`新增 ${w.event} hook：${w.entry.command}`);
      continue;
    }
    if (JSON.stringify(found.h) !== JSON.stringify(w.entry)) {
      for (const k of Object.keys(found.h)) delete found.h[k];
      Object.assign(found.h, w.entry);
      changes.push(`更新 ${w.event} hook 設定：${w.entry.command}`);
    }
    if ((found.g.matcher || '') !== w.matcher) {
      if (found.g.hooks.length === 1) {
        if (w.matcher) found.g.matcher = w.matcher;
        else delete found.g.matcher;
      } else {
        found.g.hooks = found.g.hooks.filter((h) => h !== found.h);
        s.hooks[w.event].push({ ...(w.matcher ? { matcher: w.matcher } : {}), hooks: [found.h] });
      }
      changes.push(`更新 ${w.event} matcher：${w.matcher || '（全部）'}`);
    }
  }
  const sl = tool.manifest.statusLine;
  const prevSl = prev?.statusLine;
  if (sl) {
    const cmd = hookCommand(tool, sl);
    const cur = s.statusLine?.command;
    if (!cur || norm(cur) !== norm(cmd)) {
      if (cur && norm(cur) !== norm(prevSl || '') && !force) warnings.push(`狀態列已被別的指令占用（${cur}），沒有覆蓋；要換成 ${tool.name} 的請加 --force`);
      else {
        s.statusLine = { type: 'command', command: cmd };
        changes.push(`設定狀態列：${cmd}`);
      }
    }
  } else if (prevSl && s.statusLine && norm(s.statusLine.command || '') === norm(prevSl)) {
    delete s.statusLine;
    changes.push('移除狀態列');
  }
  if (!Object.keys(s.hooks).length) delete s.hooks;
  if (changes.length && !dry) {
    backupSettings();
    const tmp = `${SETTINGS}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`);
    fs.renameSync(tmp, SETTINGS);
  }
  const registered = want.map((w) => ({ event: w.event, command: w.entry.command }));
  const statusLine = sl ? (warnings.length ? prevSl || null : hookCommand(tool, sl)) : null;
  return { changes, warnings, registered, statusLine };
}

// 每次改 settings.json 前留一份備份，只保留最近 10 份
function backupSettings() {
  if (!fs.existsSync(SETTINGS)) return;
  const dir = path.join(STATE, 'settings-backup');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(SETTINGS, path.join(dir, `settings-${Date.now()}.json`));
  const old = fs.readdirSync(dir).sort().slice(0, -10);
  for (const f of old) fs.unlinkSync(path.join(dir, f));
}

// settings.json 裡缺了哪些這個工具該有的 hook
function missingHooks(tool) {
  let s;
  try {
    s = readSettings();
  } catch {
    return ['settings.json 解析失敗'];
  }
  const miss = wantedHooks(tool)
    .filter((w) => {
      const f = findHook(s, w.event, w.entry.command);
      return !f || JSON.stringify(f.h) !== JSON.stringify(w.entry) || (f.g.matcher || '') !== w.matcher;
    })
    .map((w) => w.event);
  if (tool.manifest.statusLine && norm(s.statusLine?.command || '') !== norm(hookCommand(tool, tool.manifest.statusLine))) miss.push('statusLine');
  return miss;
}

// ---------- git pre-push：推送前自動跑公開檢查 ----------

const PRE_PUSH_MARK = '# toolkeeper pre-push';

function installPrePush(tool) {
  const file = path.join(tool.dir, '.git', 'hooks', 'pre-push');
  if (!fs.existsSync(path.dirname(file))) return '沒有 .git，略過';
  const cli = slash(path.join(HOME, 'cli.js'));
  const body = `#!/bin/sh\n${PRE_PUSH_MARK}：推送前檢查要推出去的內容能不能公開\nexec node "${cli}" check "${tool.name}" --pre-push\n`;
  const cur = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  if (cur === body) return '已安裝';
  if (cur && !cur.includes(PRE_PUSH_MARK)) return '已有別的 pre-push hook，沒有覆蓋';
  fs.writeFileSync(file, body, { mode: 0o755 });
  return '已安裝';
}

// ---------- 授權：公開的工具 repo 一律用 MIT ----------

const hasLicense = (dir) => fs.readdirSync(dir).some((f) => /^(licen[cs]e|copying)(\.|$)/i.test(f));

function mitLicense(holder, year = new Date().getFullYear()) {
  return `MIT License

Copyright (c) ${year} ${holder}

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
`;
}

// 缺授權檔就補上 MIT，著作權人用 git 的 user.name；已有授權檔就不動
function ensureLicense(tool) {
  if (hasLicense(tool.dir)) return false;
  const holder = git(tool.dir, ['config', 'user.name']).out.trim() || 'the authors';
  fs.writeFileSync(path.join(tool.dir, 'LICENSE'), mitLicense(holder));
  return true;
}

// ---------- 公開檢查 ----------

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function privateTerms() {
  try {
    return fs
      .readFileSync(TERMS_FILE, 'utf8')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  } catch {
    return [];
  }
}

function leakRules() {
  const user = os.userInfo().username;
  const rules = [
    { name: '本機使用者名稱', re: new RegExp(`(^|[^A-Za-z0-9])${esc(user)}([^A-Za-z0-9]|$)`, 'i') },
    { name: 'email', re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/, skip: /noreply@|@example\.(com|org|net)|@users\.noreply\.github\.com/i },
    { name: '金鑰或權杖', re: /sk-ant-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|AKIA[0-9A-Z]{16}|-----BEGIN [A-Z ]*PRIVATE KEY-----|xox[abprs]-[A-Za-z0-9-]{10,}/ },
  ];
  for (const t of privateTerms()) rules.push({ name: `私人詞「${t}」`, re: new RegExp(esc(t), 'i') });
  return rules;
}

const ALLOW_MARK = 'toolkeeper: allow';

function scanLine(rules, text) {
  if (text.includes(ALLOW_MARK)) return [];
  return rules.filter((r) => r.re.test(text) && !(r.skip && r.skip.test(text.match(r.re)[0]))).map((r) => r.name);
}

const clip = (s) => (s.trim().length > 100 ? `${s.trim().slice(0, 100)}…` : s.trim());

// 掃工作目錄（已追蹤＋未追蹤沒被忽略的檔）
function scanTree(tool) {
  const rules = leakRules();
  const keep = DEFAULT_KEEP.map(globRe);
  const hits = [];
  for (const rel of repoFiles(tool.dir)) {
    if (matchAny(keep, rel)) hits.push({ where: rel, rule: '執行端專有檔案（state／*.local.*）不該進 repo', text: '' });
    const buf = fs.readFileSync(path.join(tool.dir, rel));
    if (buf.includes(0)) continue;
    buf
      .toString('utf8')
      .split(/\r?\n/)
      .forEach((line, i) => {
        for (const name of scanLine(rules, line)) hits.push({ where: `${rel}:${i + 1}`, rule: name, text: clip(line) });
      });
    for (const name of scanLine(rules, rel)) hits.push({ where: rel, rule: `檔名含${name}`, text: '' });
  }
  return hits;
}

// 掃 git 歷史新增的行；range 例如 "abc..def"，省略時掃全部歷史
function scanHistory(tool, range) {
  const rules = leakRules();
  const args = ['log', '-p', '--no-color', '--no-ext-diff', '--format=commit %h', ...(range ? [range] : ['--all'])];
  const r = git(tool.dir, args);
  if (!r.ok) return [{ where: '(git log)', rule: '讀不到歷史', text: clip(r.err) }];
  const hits = [];
  let commit = '';
  let file = '';
  let ln = 0;
  for (const line of r.out.split('\n')) {
    if (line.startsWith('commit ')) commit = line.slice(7);
    else if (line.startsWith('+++ ')) file = line.replace(/^\+\+\+ (b\/)?/, '');
    else if (line.startsWith('@@')) ln = Number((line.match(/\+(\d+)/) || [])[1] || 0) - 1;
    else if (line.startsWith('+')) {
      ln++;
      for (const name of scanLine(rules, line.slice(1))) hits.push({ where: `${commit} ${file}:${ln}`, rule: name, text: clip(line.slice(1)) });
    } else if (!line.startsWith('-')) ln++;
  }
  return hits;
}

module.exports = {
  CLAUDE, HOME, STATE, LOCK_FILE, LOCAL_CONFIG, TERMS_FILE, SETTINGS,
  slash, readJson, writeJson, git, hashFile, globRe, walk, repoFiles,
  loadLocalConfig, repoRoot, listTools, loadTool, loadLock, saveLock,
  sourceFiles, runtimeFiles, plan, removeEmptyDirs, repoState,
  hookCommand, wantedHooks, syncSettings, missingHooks, installPrePush,
  hasLicense, ensureLicense, privateTerms, scanTree, scanHistory,
};
