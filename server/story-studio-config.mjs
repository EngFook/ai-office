import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { readProjectCatalog } from './project-catalog.mjs';

export const STORY_STUDIO_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const STORY_STUDIO_GEMINI_LIMIT = 8;
export const STORY_STUDIO_DEFAULT_GOAL = '为已配置项目的既有故事撰写可供选择的原创延伸场景，先研究写作技法和创意，再形成约600–1000字的中文候选剧本，核查人物动机、伏笔、因果和设定后修订。不得改写正典、代替用户确定未定真相或自动写入项目。';
export const STORY_STUDIO_DEFAULT_FOCUS = Object.freeze(['人物动机：选择与代价', '冲突：双方各自的理由', '悬疑：可核对的线索', '反转：改变解释但不改事实', '节奏：张力与停顿', '伏笔回收：局部兑现与新问题']);
export const STORY_STUDIO_DEFAULT_PREAMBLE = '以下为已配置正典来源的逐字摘录；不是完整正典。仅写可供用户选择的新候选场景，不能把新设定当作已有事实。未定的真相只能提出备选，不擅自定案。';
const PROJECT_ID = /^[a-z0-9_-]{1,100}$/i;
const CONFIG_KEYS = ['version', 'enabled', 'projectId', 'projectName', 'sourceRoot', 'projectPath', 'goal', 'focus', 'canon'];
const SOURCE_KEYS = ['path', 'mode', 'heading', 'join', 'patterns', 'minMatches', 'exactMatches', 'pattern', 'versionPattern', 'minVersion', 'requireText'];
const text = (value, max) => typeof value === 'string' && value.length <= max && Buffer.byteLength(value) <= max * 4;
const invalid = message => { throw new Error(message); };
function regex(value, flags = '') {
  if (!text(value, 500) || !value) invalid('Invalid story canon pattern');
  try { return new RegExp(value, flags); } catch { return invalid('Invalid story canon pattern'); }
}
// Project-specific canon extraction rules live in the owner's local config, never in source.
export function validateStoryCanon(input) {
  if (input === undefined || input === null) return null;
  if (!input || Array.isArray(input) || typeof input !== 'object' || Object.keys(input).some(key => !['preamble', 'sources'].includes(key))) invalid('Invalid story canon configuration');
  const preamble = input.preamble ?? STORY_STUDIO_DEFAULT_PREAMBLE;
  if (!text(preamble, 2000)) invalid('Invalid story canon preamble');
  if (!Array.isArray(input.sources) || !input.sources.length || input.sources.length > 10) invalid('Story canon needs 1-10 source files');
  const sources = input.sources.map(source => {
    if (!source || Array.isArray(source) || typeof source !== 'object' || Object.keys(source).some(key => !SOURCE_KEYS.includes(key))) invalid('Invalid story canon source');
    const relative = source.path;
    if (!text(relative, 1000) || !relative || path.isAbsolute(relative) || /[\x00-\x1f]/.test(relative) || path.normalize(relative).split(path.sep).includes('..')) invalid('Story canon source paths must be relative to sourceRoot');
    const mode = source.mode || 'full';
    if (!['full', 'lines', 'section', 'none'].includes(mode)) invalid('Invalid story canon source mode');
    const count = value => value === undefined || Number.isInteger(value) && value >= 0 && value <= 1000;
    if (!count(source.minMatches) || !count(source.exactMatches) || source.minVersion !== undefined && !Number.isFinite(source.minVersion)) invalid('Invalid story canon source limits');
    if (mode === 'lines' && (!Array.isArray(source.patterns) || !source.patterns.length || source.patterns.length > 50)) invalid('Line extraction needs patterns');
    if (mode === 'section' && !source.pattern) invalid('Section extraction needs a pattern');
    for (const key of ['heading', 'join', 'requireText']) if (source[key] !== undefined && !text(source[key], 500)) invalid('Invalid story canon source text');
    (source.patterns || []).forEach(value => regex(value)); if (source.pattern) regex(source.pattern); if (source.versionPattern) regex(source.versionPattern);
    return { path: path.normalize(relative), mode, heading: source.heading || '', join: source.join ?? '\n\n', patterns: source.patterns || [], minMatches: source.minMatches, exactMatches: source.exactMatches,
      pattern: source.pattern || null, versionPattern: source.versionPattern || null, minVersion: source.minVersion, requireText: source.requireText || null };
  });
  return { preamble, sources };
}
export function validateStoryStudioConfig(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || input.version !== 1 || typeof input.enabled !== 'boolean'
    || Object.keys(input).some(key => !CONFIG_KEYS.includes(key))) throw new Error('Invalid story studio configuration');
  const projectId = input.projectId || null;
  if (projectId !== null && (typeof projectId !== 'string' || !PROJECT_ID.test(projectId))) throw new Error('Invalid story studio project id');
  if (input.enabled && !projectId) throw new Error('Story studio needs a configured projectId');
  const projectName = input.projectName ?? projectId;
  if (projectName !== null && (typeof projectName !== 'string' || !projectName.trim() || projectName.length > 120 || /[\x00-\x1f]/.test(projectName))) throw new Error('Invalid story studio project name');
  const validPath = value => typeof value === 'string' && path.isAbsolute(value) && value.length < 4096 && !/[\x00-\x1f]/.test(value);
  if (input.enabled && (!validPath(input.sourceRoot) || !validPath(input.projectPath) || path.normalize(input.sourceRoot) !== path.normalize(input.projectPath))) throw new Error('Explicit matching story source and project paths are required');
  const goal = input.goal || STORY_STUDIO_DEFAULT_GOAL;
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000 || Buffer.byteLength(goal) > 4000) throw new Error('Invalid story goal');
  const focus = input.focus ?? STORY_STUDIO_DEFAULT_FOCUS;
  if (!Array.isArray(focus) || !focus.length || focus.length > 20 || focus.some(item => !text(item, 200) || !item.trim())) throw new Error('Invalid story focus list');
  const canon = validateStoryCanon(input.canon);
  if (input.enabled && !canon) throw new Error('Story studio needs canon sources for the configured project');
  return { version: 1, enabled: input.enabled, projectId, projectName: projectName ? projectName.trim() : null, sourceRoot: input.sourceRoot ? path.normalize(input.sourceRoot) : null,
    projectPath: input.projectPath ? path.normalize(input.projectPath) : null, goal: goal.trim(), focus: [...focus], canon,
    intervalMs: STORY_STUDIO_INTERVAL_MS, geminiDailyLimit: STORY_STUDIO_GEMINI_LIMIT };
}
// Project defaults (name, storyStudio block) may come from the owner's local
// project-catalog.json; keys in story-studio-config.json take precedence.
export function resolveStoryStudioConfig(input, catalog = []) {
  if (!input || Array.isArray(input) || typeof input !== 'object') return input;
  const project = catalog.find(item => item.id === input.projectId);
  if (!project) return input;
  const extra = project.storyStudio && typeof project.storyStudio === 'object' && !Array.isArray(project.storyStudio) ? project.storyStudio : {};
  const merged = { ...input };
  if (merged.projectName === undefined) merged.projectName = extra.projectName ?? project.name;
  for (const key of ['goal', 'focus', 'canon']) if (merged[key] === undefined && extra[key] !== undefined) merged[key] = extra[key];
  return merged;
}
export function readStoryStudioConfig(home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office')) {
  const disabled = validateStoryStudioConfig({ version: 1, enabled: false });
  try {
    const file = path.join(home, 'story-studio-config.json'), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12000) throw new Error('Invalid story config file');
    return validateStoryStudioConfig(resolveStoryStudioConfig(JSON.parse(readFileSync(file, 'utf8')), readProjectCatalog(home, { includeStoryStudio: true })));
  } catch (error) { return error.code === 'ENOENT' ? disabled : { ...disabled, error: '剧情协作配置无效；保留资料，未启动自动写作。' }; }
}
