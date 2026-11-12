import { lstatSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const STORY_STUDIO_INTERVAL_MS = 6 * 60 * 60 * 1000;
export const STORY_STUDIO_GEMINI_LIMIT = 8;
export const STORY_STUDIO_DEFAULT_GOAL = '为《退界》撰写现有三章之后可供选择的原创延伸场景，先研究写作技法和创意，再形成约600–1000字的中文候选剧本，核查人物动机、伏笔、因果和设定后修订。不得改写正典、代替用户确定未定真相或自动写入游戏。';
export function validateStoryStudioConfig(input = {}) {
  if (!input || Array.isArray(input) || typeof input !== 'object' || input.version !== 1 || typeof input.enabled !== 'boolean'
    || Object.keys(input).some(key => !['version', 'enabled', 'projectId', 'sourceRoot', 'projectPath', 'goal'].includes(key))) throw new Error('Invalid story studio configuration');
  const projectId = input.projectId || 'walkalone';
  if (projectId !== 'walkalone') throw new Error('Story studio must belong to the existing Walkalone project');
  const validPath = value => typeof value === 'string' && path.isAbsolute(value) && value.length < 4096 && !/[\x00-\x1f]/.test(value);
  if (input.enabled && (!validPath(input.sourceRoot) || !validPath(input.projectPath) || path.normalize(input.sourceRoot) !== path.normalize(input.projectPath))) throw new Error('Explicit matching Walkalone source and project paths are required');
  const goal = input.goal || STORY_STUDIO_DEFAULT_GOAL;
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 2000 || Buffer.byteLength(goal) > 4000) throw new Error('Invalid story goal');
  return { version: 1, enabled: input.enabled, projectId, sourceRoot: input.sourceRoot ? path.normalize(input.sourceRoot) : null,
    projectPath: input.projectPath ? path.normalize(input.projectPath) : null, goal: goal.trim(), intervalMs: STORY_STUDIO_INTERVAL_MS, geminiDailyLimit: STORY_STUDIO_GEMINI_LIMIT };
}
export function readStoryStudioConfig(home = process.env.AI_OFFICE_HOME || path.join(homedir(), '.ai-office')) {
  const disabled = validateStoryStudioConfig({ version: 1, enabled: false });
  try {
    const file = path.join(home, 'story-studio-config.json'), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 12000) throw new Error('Invalid story config file');
    return validateStoryStudioConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch (error) { return error.code === 'ENOENT' ? disabled : { ...disabled, error: '剧情协作配置无效；保留资料，未启动自动写作。' }; }
}
