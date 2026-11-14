#!/usr/bin/env node
import { readFileSync, existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { homedir } from 'node:os';
import { PROVIDER_IDS, officeConfigPath, validateOfficeConfig, writeOfficeConfig } from '../server/office-config.mjs';

const HELP = `AI Office 首次设置（不读取登录凭据，不启动 AI，不复制旧任务）
用法：npm run setup -- [参数]
  --yes                         非交互模式，使用安全默认值
  --lang en|zh                  Wizard language / 向导语言
  --config 路径                 配置文件（默认 ~/.ai-office/config.json）
  --from 路径                   从无密钥的 JSON 配置导入
  --overwrite                   明确允许替换已有配置，保留备份
  --data-dir 路径               本机数据目录；AI_OFFICE_HOME 优先
  --workspace 路径              默认工作目录
  --title 名称                  办公室名称
  --time-zone 时区              例如 Asia/Shanghai 或 UTC
  --mode disabled|read-only|enabled  默认 disabled，不自动执行
  --enable claude,codex          启用提供方；默认全部关闭
  --disable claude               关闭提供方
  --command claude=/路径/claude  CLI 可执行文件路径或 PATH 命令（不是 shell 命令）
  --model local-qwen=qwen3:8b    模型名称，使用已安装的模型
  --concurrency claude=2         并发数 1–8（Local Qwen/Grok Bot 固定 1）
  --reviewer claude=codex        独立审查员，不能是作者本人
  --ollama-url http://127.0.0.1:11434
  --ollama-model qwen3:8b
  --help                        显示帮助
Claude/Codex 使用你自己已安装 CLI 的订阅登录。请在各自 CLI 中登录。
密钥不得写入配置或 Git；Grok webhook 仅通过环境变量配置。
read-only 不会自动执行任务。enabled 才允许接单，并仍受提供方配置及审查约束。`;

function splitAssignment(value, flag) {
  const at = value.indexOf('=');
  const id = value.slice(0, at);
  if (at < 1 || !PROVIDER_IDS.includes(id)) throw new Error(`${flag} 格式应为 提供方=值。`);
  return [id, value.slice(at + 1)];
}

export async function setupOffice(argv = process.argv.slice(2), { env = process.env, home = homedir(), cwd = process.cwd(), input = process.stdin, output = process.stdout } = {}) {
  const flags = {}, assignments = [], enable = [], disable = [];
  const valueFlags = ['lang', 'config', 'from', 'data-dir', 'workspace', 'title', 'time-zone', 'mode', 'enable', 'disable', 'command', 'model', 'concurrency', 'reviewer', 'ollama-url', 'ollama-model'];
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index].replace(/^--/, '');
    if (argv[index] === '--help') { output.write(`${HELP}\n`); return null; }
    if (['--yes', '--overwrite'].includes(argv[index])) { flags[key] = true; continue; }
    if (!argv[index].startsWith('--') || !valueFlags.includes(key) || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('不支持的参数或缺少参数值；请用 --help 查看用法。');
    const value = argv[++index];
    if (['command', 'model', 'concurrency', 'reviewer'].includes(key)) assignments.push([key, ...splitAssignment(value, key)]);
    else if (key === 'enable' || key === 'disable') {
      const ids = value.split(',');
      if (ids.some(id => !PROVIDER_IDS.includes(id))) throw new Error('提供方名称无效。');
      (key === 'enable' ? enable : disable).push(...ids);
    } else flags[key] = value;
  }
  if (flags.lang && !['en','zh'].includes(flags.lang)) throw new Error('--lang must be en or zh');
  const english = flags.lang === 'en';
  const options = { env, home, cwd, configPath: flags.config };
  const configPath = officeConfigPath(options);
  if (existsSync(configPath) && !flags.overwrite) throw new Error('配置已存在，未改动。需要修改请加 --overwrite，旧配置会备份。');
  let source = {};
  const importPath = flags.from ? path.resolve(cwd, flags.from) : existsSync(configPath) ? configPath : null;
  if (importPath) {
    try { source = JSON.parse(readFileSync(importPath, 'utf8')); } catch { throw new Error('无法读取导入配置，请检查 JSON 格式与文件权限。'); }
  }
  const config = validateOfficeConfig(source, { home, cwd, baseDir: importPath ? path.dirname(importPath) : path.dirname(configPath) });
  // Respect the existing data directory environment setting without migrating any data.
  if (env.AI_OFFICE_HOME && !flags['data-dir']) config.dataDir = path.resolve(cwd, env.AI_OFFICE_HOME.startsWith('~/') && home ? path.join(home, env.AI_OFFICE_HOME.slice(2)) : env.AI_OFFICE_HOME);
  const fields = { 'data-dir': 'dataDir', workspace: 'workspace', title: 'title', 'time-zone': 'timeZone', mode: 'mode' };
  for (const [flag, field] of Object.entries(fields)) if (flags[flag]) config[field] = ['dataDir', 'workspace'].includes(field) && !flags[flag].startsWith('~') ? path.resolve(cwd, flags[flag]) : flags[flag];
  for (const id of enable) config.providers[id].enabled = true;
  for (const id of disable) config.providers[id].enabled = false;
  for (const [field, id, value] of assignments) {
    if (field === 'reviewer') config.reviewerFor[id] = value;
    else config.providers[id][field] = field === 'concurrency' ? Number(value) : value;
    if (field === 'model' && id === 'local-qwen') config.ollama.model = value;
  }
  if (flags['ollama-url']) config.ollama.url = flags['ollama-url'];
  if (flags['ollama-model']) config.ollama.model = flags['ollama-model'];
  if (!flags.yes) {
    if (!input.isTTY) throw new Error('非交互环境请添加 --yes；默认不会启用 AI 或执行任务。');
    const rl = createInterface({ input, output });
    const ask = async (label, value, en = label) => (await rl.question(`${english ? en : label} [${value}]: `)).trim() || value;
    try {
      config.title = await ask('办公室名称', config.title, 'Office name');
      config.workspace = await ask('默认工作目录', config.workspace, 'Existing project folder');
      config.dataDir = await ask('本机数据目录', config.dataDir, 'Private data directory');
      config.timeZone = await ask('时区', config.timeZone, 'Time zone');
      for (const id of PROVIDER_IDS) {
        config.providers[id].enabled = /^y(es)?$/i.test(await ask(`启用 ${id}？输入 yes 或 no`, config.providers[id].enabled ? 'yes' : 'no', `Enable ${id}? yes or no`));
        if (config.providers[id].enabled) {
          if (['claude', 'codex', 'gemini'].includes(id)) config.providers[id].command = await ask(`${id} CLI 命令或路径`, config.providers[id].command, `${id} CLI executable or path`);
          if (['claude', 'codex', 'gemini'].includes(id)) {
            config.providers[id].model = await ask(`${id} 模型（留空使用 CLI 默认）`, config.providers[id].model, `${id} model (blank uses CLI default)`);
            config.providers[id].concurrency = Number(await ask(`${id} 最大并发数`, String(config.providers[id].concurrency), `${id} maximum concurrent workers`));
          }
        }
      }
      for (const id of ['claude', 'codex'].filter(id => config.providers[id].enabled)) {
        const reviewer = await ask(`${id} 的独立审查员（不能是作者）`, config.reviewerFor[id] || '', `${id} independent reviewer (must differ from author)`);
        if (reviewer) config.reviewerFor[id] = reviewer;
        else delete config.reviewerFor[id];
      }
      if (config.providers['local-qwen'].enabled) {
        config.ollama.url = await ask('Ollama 地址', config.ollama.url, 'Ollama URL');
        config.ollama.model = await ask('已安装的 Ollama 模型', config.ollama.model || config.providers['local-qwen'].model, 'Installed Ollama model');
        config.providers['local-qwen'].model = config.ollama.model;
      }
      config.mode = await ask('执行模式：disabled / read-only / enabled', config.mode, 'Execution mode: disabled / read-only / enabled');
      if (!/^y(es)?$/i.test(await ask('保存配置？输入 yes 确认', 'no', 'Save configuration? Type yes to confirm'))) { output.write(english ? 'Cancelled; configuration unchanged.\n' : '已取消，未修改配置。\n'); return null; }
    } finally { rl.close(); }
  }
  const saved = writeOfficeConfig(config, { ...options, overwrite: !!flags.overwrite });
  output.write(english ? `Configuration saved: ${saved.configPath}\nMode: ${saved.mode}. No AI was started and existing tasks were not changed.\n` : `配置已保存：${saved.configPath}\n执行模式：${saved.mode}。本步骤没有启动 AI 或修改旧任务。\n`);
  if (saved.backupPath) output.write(`${english ? 'Previous configuration backup' : '旧配置备份'}: ${saved.backupPath}\n`);
  if (env.AI_OFFICE_HOME) output.write(english ? 'AI_OFFICE_HOME overrides the runtime data directory.\n' : 'AI_OFFICE_HOME 已设置，运行时会优先使用该数据目录。\n');
  for (const id of ['claude', 'codex'].filter(id => saved.providers[id].enabled)) {
    const reviewer = saved.reviewerFor[id];
    if (!reviewer || !saved.providers[reviewer]?.enabled) output.write(english ? `${id}: independent reviewer is not enabled; reviewed tasks will wait. The author cannot review itself.\n` : `${id} 尚无已启用的独立审查员；需要审查的任务将等待配置，不会改由作者自审。\n`);
  }
  output.write(english ? 'Check environment: npm run doctor\nStart office: npm start\nStop and restart the office after configuration changes.\n' : '检查环境：npm run doctor\n启动办公室：npm start\n更改配置后请先停止并重新启动办公室。\n');
  return saved;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  setupOffice().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
