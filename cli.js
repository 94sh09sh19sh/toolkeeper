// toolkeeper 指令：status、deploy、diff、check、new、remove
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const L = require('./lib');

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const [cmd = 'status', arg] = argv.filter((a) => !a.startsWith('--'));
const has = (f) => flags.has(f);

const ROOT = L.repoRoot();
const tilde = (p) => L.slash(p).replace(L.slash(L.CLAUDE), '~/.claude');

function fail(msg) {
  console.log(msg);
  process.exit(1);
}

function needRoot() {
  if (!ROOT) fail(`找不到工具 repo 的資料夾；在 ${L.slash(L.LOCAL_CONFIG)} 設定 repoRoot，或從 repo 裡的 toolkeeper 執行一次 deploy toolkeeper`);
  return ROOT;
}

function names(a) {
  const all = L.listTools(needRoot());
  if (!a) fail('要指定工具名稱或 all');
  if (a === 'all') return all;
  if (!all.includes(a)) fail(`${L.slash(ROOT)} 底下沒有含 deploy.json 的 ${a}`);
  return [a];
}

// 執行端的本機特例檔（*.local.*）與行數，用來看特例有沒有越積越多
function localFiles(tool) {
  return L.walk(tool.target)
    .filter((rel) => /(^|\/)[^/]*\.local\.[^/]*$/.test(rel))
    .map((rel) => {
      const file = path.join(tool.target, rel);
      if (rel.endsWith('.json')) return `${rel}（${Object.keys(L.readJson(file, {})).length} 個設定）`;
      const n = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !l.trim().startsWith('#')).length;
      return `${rel}（${n} 行）`;
    });
}

function status() {
  const root = needRoot();
  const lock = L.loadLock();
  console.log(`工具 repo：${L.slash(root)}｜執行端：${L.slash(L.CLAUDE)}｜私人詞：${L.privateTerms().length} 個`);
  for (const name of L.listTools(root)) {
    let tool;
    try {
      tool = L.loadTool(root, name);
    } catch (e) {
      console.log(`\n${name}：${e.message}`);
      continue;
    }
    const rs = L.repoState(tool.dir);
    const p = L.plan(tool, lock);
    const prev = lock.tools[name];
    const repo = !rs.git
      ? '不是 git repo'
      : [rs.commit || '還沒有 commit', rs.dirty ? `未提交 ${rs.dirty} 檔` : '乾淨', !rs.upstream ? '沒有遠端' : rs.ahead ? `領先遠端 ${rs.ahead}` : '已推送', rs.behind ? `落後遠端 ${rs.behind}` : ''].filter(Boolean).join('，');
    let run;
    if (!prev && !Object.keys(p.run).length) run = '未部署';
    else if (p.drift.length) run = `被直接改過 ${p.drift.length} 檔（先跑 diff ${name}）`;
    else if (p.copy.length || p.remove.length) run = `待部署：更新 ${p.copy.length} 檔、刪除 ${p.remove.length} 檔`;
    else run = `已同步${prev?.commit ? `（${prev.commit}${prev.dirty ? '＋未提交改動' : ''}）` : ''}`;
    if (p.unmanaged.length) run += `；來路不明 ${p.unmanaged.length} 檔`;
    const hits = L.scanTree(tool);
    const miss = L.missingHooks(tool);
    const locals = localFiles(tool);
    console.log(`\n${name} → ${tilde(tool.target)}`);
    console.log(`  repo：${repo}`);
    console.log(`  執行端：${run}`);
    if (miss.length) console.log(`  settings：缺 ${miss.join('、')}（deploy ${name} 會補上）`);
    if (locals.length) console.log(`  本機特例：${locals.join('、')}`);
    console.log(`  公開檢查：${hits.length ? `${hits.length} 處（check ${name}）` : '通過'}`);
  }
}

function syntaxErrors(tool, src) {
  return Object.keys(src)
    .filter((rel) => /\.(c|m)?js$/.test(rel))
    .filter((rel) => spawnSync(process.execPath, ['--check', path.join(tool.dir, rel)], { stdio: 'ignore' }).status !== 0);
}

function backup(tool, rels, label) {
  const dir = path.join(L.STATE, 'backup', `${tool.name}-${label}-${Date.now()}`);
  for (const rel of rels) {
    const from = path.join(tool.target, rel);
    if (!fs.existsSync(from)) continue;
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.copyFileSync(from, path.join(dir, rel));
  }
  return dir;
}

function deployOne(name) {
  const root = needRoot();
  const tool = L.loadTool(root, name);
  const lock = L.loadLock();
  const p = L.plan(tool, lock);
  const dry = has('--dry-run');
  const force = has('--force');
  console.log(`== ${name} → ${tilde(tool.target)}`);

  const bad = syntaxErrors(tool, p.src);
  if (bad.length) return console.log(`  中止：語法錯誤 ${bad.join('、')}`), false;
  if (tool.manifest.test) {
    const r = spawnSync(tool.manifest.test, { cwd: tool.dir, shell: true, stdio: 'inherit' });
    if (r.status !== 0) return console.log(`  中止：測試失敗（${tool.manifest.test}）`), false;
  }
  if (p.drift.length && !force) {
    console.log('  中止：執行端有不是從 repo 部署的改動；要保留就先把改動搬回 repo，不要就加 --force 覆蓋（會先備份）');
    for (const d of p.drift) console.log(`  - ${d.rel}：${d.kind}`);
    console.log(`  看差異：node ${L.slash(path.join(L.HOME, 'cli.js'))} diff ${name}`);
    return false;
  }

  let st;
  try {
    st = L.syncSettings(tool, p.prev, { dry: true, force });
  } catch (e) {
    return console.log(`  中止：settings.json 讀不進來（${e.message}），不動它`), false;
  }
  const prune = has('--prune');
  const lines = [
    ...p.copy.map((r) => `  更新 ${r}`),
    ...p.remove.map((r) => `  刪除 ${r}`),
    ...p.unmanaged.map((r) => `  ${prune ? '刪除' : '保留'}來路不明的 ${r}${prune ? '' : '（加 --prune 刪除）'}`),
    ...st.changes.map((c) => `  settings：${c}`),
    ...st.warnings.map((w) => `  注意：${w}`),
  ];
  if (p.prev && p.prev.target !== tool.targetRel) lines.push(`  搬家：清掉舊位置 ~/.claude/${p.prev.target} 的檔案`);
  console.log(lines.length ? lines.join('\n') : '  沒有變更');
  if (dry) return true;

  if (p.drift.length) console.log(`  已備份被覆蓋的檔案：${L.slash(backup(tool, p.drift.map((d) => d.rel), 'drift'))}`);
  if (prune && p.unmanaged.length) console.log(`  已備份刪除的檔案：${L.slash(backup(tool, p.unmanaged, 'prune'))}`);
  for (const rel of p.copy) {
    const to = path.join(tool.target, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(tool.dir, rel), to);
  }
  for (const rel of [...p.remove, ...(prune ? p.unmanaged : [])]) {
    fs.rmSync(path.join(tool.target, rel), { force: true });
    L.removeEmptyDirs(path.dirname(path.join(tool.target, rel)), tool.target);
  }
  // 換了部署位置：舊位置只刪當初部署、內容沒變的檔
  if (p.prev && p.prev.target !== tool.targetRel) {
    const old = path.join(L.CLAUDE, p.prev.target);
    for (const [rel, h] of Object.entries(p.prev.files || {})) {
      const f = path.join(old, rel);
      if (fs.existsSync(f) && L.hashFile(f) === h) {
        fs.rmSync(f);
        L.removeEmptyDirs(path.dirname(f), L.CLAUDE);
      }
    }
  }
  const real = L.syncSettings(tool, p.prev, { force });
  const pp = L.installPrePush(tool);
  const rs = L.repoState(tool.dir);
  lock.tools[name] = {
    target: tool.targetRel,
    commit: rs.commit || null,
    dirty: Boolean(rs.dirty),
    deployedAt: new Date().toISOString(),
    files: p.src,
    hooks: real.registered,
    statusLine: real.statusLine,
  };
  L.saveLock(lock);
  console.log(`  完成｜pre-push 檢查：${pp}${rs.dirty ? '｜注意：部署的是未提交的改動' : ''}`);
  return true;
}

function deploy() {
  const list = names(arg);
  // 第一次從 repo 部署時記下 repo 位置，之後從執行端執行也找得到
  const cfg = L.loadLocalConfig();
  if (!cfg.repoRoot && !has('--dry-run')) L.writeJson(L.LOCAL_CONFIG, { ...cfg, repoRoot: L.slash(ROOT) });
  let ok = true;
  for (const n of list) ok = deployOne(n) && ok;
  if (!ok) process.exit(1);
}

function diff() {
  const tool = L.loadTool(needRoot(), names(arg)[0]);
  const p = L.plan(tool, L.loadLock());
  const rels = [...new Set([...p.copy, ...p.remove, ...p.unmanaged, ...p.drift.map((d) => d.rel)])].sort();
  if (!rels.length) return console.log('執行端與 repo 相同');
  for (const rel of rels) {
    const a = path.join(tool.target, rel);
    const b = path.join(tool.dir, rel);
    if (!fs.existsSync(a)) console.log(`只有 repo 有：${rel}`);
    else if (!p.src[rel]) console.log(`只有執行端有：${rel}`);
    else spawnSync('git', ['-c', 'core.autocrlf=false', 'diff', '--no-index', '--no-color', '--', L.slash(a), L.slash(b)], { stdio: 'inherit' });
  }
  console.log('（- 是執行端，+ 是 repo）');
}

function readStdin() {
  try {
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function check() {
  const list = names(arg);
  if (!L.privateTerms().length) console.log(`提醒：沒有私人詞清單（${L.slash(L.TERMS_FILE)}），只檢查本機路徑、email、金鑰`);
  let total = 0;
  for (const n of list) {
    const tool = L.loadTool(ROOT, n);
    let hits = [];
    if (has('--pre-push')) {
      // git 從 stdin 給「本地 ref 本地 sha 遠端 ref 遠端 sha」；只掃這次要推出去的 commit
      for (const line of readStdin().split('\n').filter(Boolean)) {
        const [, local, , remote] = line.split(' ');
        if (/^0+$/.test(local)) continue;
        hits = hits.concat(L.scanHistory(tool, /^0+$/.test(remote) ? local : `${remote}..${local}`));
      }
    } else hits = has('--history') ? L.scanHistory(tool) : L.scanTree(tool);
    total += hits.length;
    if (hits.length) {
      console.log(`== ${n}：${hits.length} 處`);
      for (const h of hits) console.log(`  ${h.where}｜${h.rule}${h.text ? `｜${h.text}` : ''}`);
    } else if (!has('--pre-push')) console.log(`== ${n}：通過`);
  }
  if (total) {
    console.log('\n確定可以公開的行，在該行加上註解 toolkeeper: allow；私人詞清單在本機設定，不會進 repo。');
    process.exit(1);
  }
}

function create() {
  const root = needRoot();
  const name = arg;
  if (!name || !/^[a-z0-9][a-z0-9-]*$/.test(name)) fail('名稱只能用小寫英文、數字、連字號');
  const dir = path.join(root, name);
  if (fs.existsSync(dir)) fail(`${L.slash(dir)} 已存在`);
  const skill = has('--skill');
  fs.mkdirSync(dir, { recursive: true });
  const files = {
    'deploy.json': `${JSON.stringify(skill ? { target: `skills/${name}` } : { target: name, hooks: [] }, null, 2)}\n`,
    '.gitignore': 'state/\n*.local.*\n',
    'README.md': [
      `# ${name}`,
      '',
      '（一句話說明這個工具做什麼）',
      '',
      '## 安裝',
      skill ? `- 把 \`SKILL.md\` 與其他檔案放到 \`~/.claude/skills/${name}/\`（README 不用放）。` : `- 把檔案放到 \`~/.claude/${name}/\`，再依下方設定掛上 hook。`,
      '',
      '## 設定',
      '- 預設值寫在 repo；個人設定放執行端的 `config.local.json`，不會被部署覆蓋，也不會進 repo。',
      '',
    ].join('\n'),
  };
  if (skill) files['SKILL.md'] = ['---', `name: ${name}`, 'description: （何時使用：寫清楚觸發情境，這段每個 session 都會載入，越短越好）', '---', '', `# ${name}`, ''].join('\n');
  for (const [f, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), body);
  L.git(dir, ['init', '-b', 'main']);
  const tool = L.loadTool(root, name);
  console.log(`已建立 ${L.slash(dir)}（${skill ? 'skill' : 'hook／指令工具'}）｜pre-push 檢查：${L.installPrePush(tool)}`);
  console.log(`接著：寫程式${skill ? '與 SKILL.md' : '，在 deploy.json 的 hooks 填上要掛的事件'} → deploy ${name} 試用 → commit → gh repo create 建遠端 → push`);
}

function remove() {
  const root = needRoot();
  const tool = L.loadTool(root, names(arg)[0]);
  const lock = L.loadLock();
  const prev = lock.tools[tool.name];
  if (!prev) fail(`${tool.name} 沒有部署紀錄`);
  const old = { ...tool, targetRel: prev.target, target: path.join(L.CLAUDE, prev.target) };
  const changed = Object.entries(prev.files).filter(([rel, h]) => fs.existsSync(path.join(old.target, rel)) && L.hashFile(path.join(old.target, rel)) !== h).map(([rel]) => rel);
  if (changed.length) console.log(`已備份被直接改過的檔案：${L.slash(backup(old, changed, 'remove'))}`);
  for (const rel of Object.keys(prev.files)) {
    fs.rmSync(path.join(old.target, rel), { force: true });
    L.removeEmptyDirs(path.dirname(path.join(old.target, rel)), old.target);
  }
  const st = L.syncSettings({ ...old, manifest: { hooks: [] } }, prev);
  for (const c of st.changes) console.log(`settings：${c}`);
  if (has('--purge')) fs.rmSync(old.target, { recursive: true, force: true });
  else L.removeEmptyDirs(old.target, L.CLAUDE);
  delete lock.tools[tool.name];
  L.saveLock(lock);
  console.log(`已從執行端移除 ${tool.name}${has('--purge') ? '（含狀態與本機設定）' : '；狀態與本機設定保留，加 --purge 一起刪'}`);
}

const HELP = `用法：node cli.js <指令>
  status                         各工具的 repo、執行端、本機特例、公開檢查狀態
  deploy <名稱|all> [--dry-run] [--force] [--prune]
                                 repo → 執行端；--force 覆蓋直接改過的檔（先備份）；--prune 刪除來路不明的檔
  diff <名稱>                    執行端與 repo 的差異
  check <名稱|all> [--history]   公開檢查（工作目錄；--history 掃全部 git 歷史）
  new <名稱> [--skill]           建立新工具 repo
  remove <名稱> [--purge]        從執行端移除並取消 settings 註冊`;

const cmds = { status, deploy, diff, check, new: create, remove };
if (cmds[cmd]) cmds[cmd]();
else console.log(HELP);
