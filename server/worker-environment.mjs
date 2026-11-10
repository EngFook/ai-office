// Office transport credentials belong only to the office service, never to a
// provider worker, login check or quota CLI (including its own descendants).
export function workerEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !/^(?:XAI_|GROK_|AI_OFFICE_)/i.test(key)));
}
