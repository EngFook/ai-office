import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export function watchDecisionArgs(provider, prompt) {
  if (provider === 'codex') return ['exec', '--json', '--ignore-user-config', '--sandbox', 'read-only', '--skip-git-repo-check', '--ephemeral', '-'];
  if (provider === 'claude') return ['--print', '--output-format', 'stream-json', '--verbose', '--tools', '', '--strict-mcp-config', '--safe-mode', '--disable-slash-commands'];
  if (provider === 'gemini') return ['-p', prompt, '--mode', 'plan', '--sandbox', '--disable-slash-commands', '--output-format', 'json', '--print-timeout', '120s'];
  throw new Error('Unknown watch recipient.');
}

// Separate, bounded decision turn: no task claim, no Qwen model output, no write
// permissions or coding-folder access. Native worker launch happens afterwards.
export async function runWatchDecision({ provider, binary, prompt, spawnProcess, terminate, platform, env, signal, timeoutMs = 120000, killGraceMs = 1500, parseResponse = parseWatchDecisions }) {
  const directory = await mkdtemp(path.join(tmpdir(), 'office-watch-decision-'));
  try {
    if (signal.aborted) throw new Error('Watch delivery stopped.');
    return await new Promise((resolve, reject) => {
      const decoder = new StringDecoder('utf8');
      let child, timer, killTimer, settled = false, output = '', bytes = 0, aborting = false;
      const finish = (error, value) => {
        if (settled) return;
        settled = true; clearTimeout(timer); clearTimeout(killTimer); signal.removeEventListener('abort', abort);
        error ? reject(error) : resolve(value);
      };
      const abort = () => {
        if (settled || aborting) return;
        aborting = true;
        try { terminate(child, 'SIGTERM', platform); } catch {}
        if (!settled) killTimer = setTimeout(() => { try { terminate(child, 'SIGKILL', platform); } catch {} finish(new Error('Watch decision cancelled.')); }, killGraceMs);
      };
      try {
        child = spawnProcess(binary, watchDecisionArgs(provider, prompt), { cwd: directory, env, shell: false, detached: platform !== 'win32', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch { finish(new Error('Watch recipient could not start.')); return; }
      child.stdout?.on('data', chunk => {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) { abort(); return; }
        output += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      child.stderr?.on('data', () => {});
      child.stdin?.on('error', abort);
      child.on('error', () => { abort(); finish(new Error('Watch recipient failed.')); });
      child.on('close', code => {
        if (code !== 0 || aborting) { finish(new Error('Watch recipient did not complete.')); return; }
        try {
          output += decoder.end();
          let text = '', complete = false;
          const events = provider === 'gemini' ? [JSON.parse(output)] : output.trim().split('\n').map(line => JSON.parse(line));
          for (const event of events) {
            if (provider === 'codex') {
              if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
              if (event.type === 'turn.completed') complete = true;
              if (['turn.failed', 'error'].includes(event.type)) throw new Error();
            } else if (provider === 'claude' && event.type === 'result') {
              complete = event.is_error !== true && (!event.subtype || event.subtype === 'success');
              text = event.structured_output ? JSON.stringify(event.structured_output) : event.result;
            } else if (provider === 'gemini') { complete = event.status === 'SUCCESS'; text = event.response; }
          }
          if (!complete || typeof text !== 'string') throw new Error();
          const value = JSON.parse(text.trim().replace(/^```(?:json)?\s*([\s\S]*?)\s*```$/, '$1'));
          finish(null, parseResponse(value));
        } catch { finish(new Error('Watch recipient returned no valid decision.')); }
      });
      signal.addEventListener('abort', abort, { once: true });
      timer = setTimeout(abort, timeoutMs); timer.unref?.();
      if (signal.aborted) abort();
      else { try { child.stdin?.end(provider === 'gemini' ? '' : prompt); } catch { abort(); } }
    });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function parseWatchDecisions(value) {
  if (!Array.isArray(value.decisions) || value.decisions.length > 100 || value.decisions.some(item => !item || typeof item.taskId !== 'string' || !['wait', 'retry', 'run'].includes(item.action))) throw new Error('Invalid watch decisions.');
  return value.decisions.map(({ taskId, action }) => ({ taskId, action }));
}
