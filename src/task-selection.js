// Category changes and live updates must never carry hidden cards into a batch.
export function selectedForScope(checked, tasks) {
  const visible = new Set(tasks.map(task => task.id));
  return Object.values(checked).filter(item => visible.has(item.id)).slice(0, 100);
}
