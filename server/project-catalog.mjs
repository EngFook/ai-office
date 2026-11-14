import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

// Optional owner-maintained project list. Worktree aliases affect presentation
// and filtering only, never execution paths, project locks or task history.
export function readProjectCatalog(home = path.join(homedir(), '.ai-office'), { includeStoryStudio = false } = {}) {
  try {
    const input = JSON.parse(readFileSync(path.join(home, 'project-catalog.json'), 'utf8'));
    if (!Array.isArray(input) || input.length > 100) return [];
    const ids = new Set();
    return input.map(item => {
      if (!item || typeof item.id !== 'string' || !/^[a-z0-9_-]{1,100}$/i.test(item.id) || ids.has(item.id) || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 120) throw new Error('Invalid project');
      ids.add(item.id);
      const folders = [item.path, ...(item.folders || [])];
      if (folders.length > 1000 || folders.some(folder => typeof folder !== 'string' || !path.isAbsolute(folder) || /[\x00-\x1f]/.test(folder))) throw new Error('Invalid folder');
      const storyStudio = includeStoryStudio && item.storyStudio && typeof item.storyStudio === 'object' && !Array.isArray(item.storyStudio) ? { storyStudio: item.storyStudio } : {};
      return { id:item.id, name:item.name.trim(), path:path.normalize(item.path), folders:[...new Set(folders.map(folder=>path.normalize(folder)))], ...storyStudio };
    });
  } catch { return []; }
}
