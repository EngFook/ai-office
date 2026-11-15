import path from 'node:path';

// Callers resolve symlinks before comparing. Distinct sibling projects and Git
// worktrees remain independent; a parent folder contains its nested projects.
export function projectPathsOverlap(left, right) {
  if (!left || !right) return false;
  const contains = (parent, child) => {
    const relative = path.relative(parent, child);
    return relative === '' || relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  };
  return contains(left, right) || contains(right, left);
}

export const holdsCodingProject = task => !['gemini', 'local-qwen', 'grok-bot'].includes(task.provider);
