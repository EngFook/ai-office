import test from 'node:test';
import assert from 'node:assert/strict';
import { DICT, translate, hasEntry } from '../src/i18n.js';
import { SHARED_DEPARTMENTS, officeRoleLabel, officeRoleDescription } from '../src/unified-office.js';

test('every i18n key has both English and Chinese', () => {
  for (const e of DICT) {
    assert.ok(e.en && e.en.trim(), `missing en: ${JSON.stringify(e)}`);
    assert.ok(e.zh && e.zh.trim(), `missing zh for "${e.en}"`);
    const ph = s => [...s.matchAll(/\{([a-z])\}/g)].map(m => m[1]).sort().join();
    assert.equal(ph(e.en), ph(e.zh), `placeholder mismatch for "${e.en}"`);
  }
});
test('no duplicate English keys with different Chinese', () => {
  const seen = new Map();
  for (const e of DICT) { if (seen.has(e.en)) assert.equal(seen.get(e.en), e.zh, e.en); seen.set(e.en, e.zh); }
});
test('translates both directions, templates and segments', () => {
  assert.equal(translate('Task board', 'zh'), '任务板');
  assert.equal(translate('任务板', 'en'), 'Task board');
  assert.equal(translate('3 working', 'zh'), '3 人工作中');
  assert.equal(translate('42% left', 'zh'), '剩余 42%');
  assert.equal(translate('Running · Codex Review & Balance', 'zh'), '运行中 · Codex 审查与平衡');
  assert.equal(translate('实际同时工作: 1 写代码 + 2 审查 + 0 研究', 'en'), 'Working now: 1 coding + 2 reviewing + 0 research');
  assert.equal(translate('Fix the login bug', 'zh'), 'Fix the login bug');
  assert.ok(hasEntry('Claude Build Studio'));
});
test('approved departments, roles and labels have Chinese pairs', () => {
  const labels = [...SHARED_DEPARTMENTS, 'Main Area', 'Lounge & Coffee', 'Reports', 'Dispatch', 'Task Board',
    'Studio', 'Specialist Roles', 'Specialist Reviewers', 'Dispatch via Grok', 'Find agent', 'View agent',
    'Sign-in needed', 'To do', 'Queued', 'Blocked', 'Playtester',
    officeRoleLabel('Manager', 'Grok'), officeRoleLabel('Researcher', 'Gemini'), officeRoleLabel('Admin', 'Codex'),
    officeRoleLabel('Facilitator', 'Codex'), officeRoleLabel('Helper', 'Codex'), officeRoleLabel('Helper', 'Grok'),
    ...['Claude Code', 'Codex', 'Gemini', 'Grok'].map(provider => officeRoleDescription({ provider }))];
  for (const label of labels) assert.ok(hasEntry(label), `missing approved label: ${label}`);
  assert.equal(translate('Facilitator', 'zh'), '主持人');
  assert.equal(translate('Playtester', 'zh'), '试玩测试员');
  assert.equal(translate('To do', 'zh'), '待处理');
  assert.equal(translate('Queued', 'zh'), '排队中');
});
test('template interpolation preserves user and agent content verbatim', () => {
  assert.equal(translate('Assigned to Review', 'zh'), '分配给 Review');
  assert.equal(translate('Assigned to 完成', 'en'), 'Assigned to 完成');
  assert.equal(translate('Assigned to $&', 'zh'), '分配给 $&');
  assert.equal(translate('Open Builder, Codex, agent Done, Running, Reports', 'zh'), '打开 Builder，Codex，代理 Done，运行中，Reports');
});
test('UI string literals in src JSX are covered', async () => {
  const fs = await import('node:fs');
  const { transform } = await import('esbuild');
  const { parseAst } = await import('rollup/parseAst');
  const brands = /^(Claude|Codex|Grok|Gemini|Claude Code|Claude · Codex · Grok(?: · Gemini)?|Three\.js|Godot|Unity|Unreal|Roblox|Luau|SGT|3D|EN)$/;
  const missing = new Set();
  for (const f of fs.readdirSync(new URL('../src/', import.meta.url))) {
    if (!f.endsWith('.jsx')) continue;
    const src = fs.readFileSync(new URL('../src/' + f, import.meta.url), 'utf8');
    const ast = parseAst((await transform(src, { loader: 'jsx', jsx: 'transform' })).code);
    const check = value => {
      const s = value.trim();
      if (/[A-Za-z]{2}/.test(s) && !brands.test(s) && !hasEntry(s) && translate(s, 'zh') === s) missing.add(`${f}: ${s}`);
    };
    const checkValue = node => {
      if (!node) return;
      if (node.type === 'Literal' && typeof node.value === 'string') check(node.value);
      else if (node.type === 'TemplateLiteral' && !node.expressions.length) check(node.quasis[0].value.cooked);
      else if (node.type === 'ConditionalExpression') { checkValue(node.consequent); checkValue(node.alternate); }
      else if (node.type === 'LogicalExpression') checkValue(node.right);
    };
    const walk = node => {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression' && node.callee.type === 'MemberExpression' && node.callee.property.name === 'createElement') {
        const [tag, props, ...children] = node.arguments;
        const attributes = props?.type === 'ObjectExpression' ? props.properties : [];
        if (attributes.some(p => (p.key?.value || p.key?.name) === 'data-no-i18n') || ['code', 'pre', 'script', 'style'].includes(tag?.value)) return;
        for (const attribute of attributes) if (['placeholder', 'aria-label', 'title', 'label', 'caption'].includes(attribute.key?.value || attribute.key?.name)) checkValue(attribute.value);
        children.forEach(checkValue);
      }
      if (node.type === 'CallExpression' && node.callee.type === 'Identifier' && node.callee.name === 't') checkValue(node.arguments[0]);
      for (const value of Object.values(node)) if (Array.isArray(value)) value.forEach(walk); else if (value && typeof value === 'object') walk(value);
    };
    walk(ast);
  }
  assert.deepEqual([...missing].sort(), []);
});
