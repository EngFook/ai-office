import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createGrokBotPresence } from './grok-bot-presence.mjs';
import { createTaskStore } from './task-store.mjs';
import { createTaskRunner } from './task-runner.mjs';
import { createGrokManagement } from './grok-management.mjs';
import { taskBoardBridge } from './task-board-bridge.mjs';
import { createQwenWatch } from './qwen-watch.mjs';
import { createQwenWatchReport } from './qwen-watch-report.mjs';
import { readGrokQuota } from './usage-bridge.mjs';
import { createQwenHuddle } from './qwen-huddle.mjs';
import { createGrokWake } from './grok-wake.mjs';

// The same local services back development and preview. No workers are started
// by a production build or by importing the configuration.
export function officeServices(options = {}) {
  let store, runner, grok, watch, huddle, grokWake, relayTimer, relayPending, stopping;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(relayTimer);
      await grokWake?.stop();
      await relayPending;
      await Promise.allSettled([watch?.stop(), huddle?.stop()]);
      await Promise.allSettled([runner?.stop(), grok?.stop()]);
      store?.close?.();
    })();
    return stopping;
  }
  function install(server) {
    store = createTaskStore(options.store);
    const presence = createGrokBotPresence();
    const projectPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const commandInterface = { projectPath, scriptPath:path.join(projectPath,'scripts','office-board.mjs'), commands:['status','pending-questions','triage-question','acknowledge-question','answer-question','pending-instructions','add-task','add-role','apply-plan','bot-heartbeat','claim','claim-next','heartbeat','finish'] };
    grokWake = createGrokWake({ home: options.store?.home, ...options.grokWake });
    const relayTick = () => {
      if (stopping || relayPending) return relayPending;
      relayPending = Promise.resolve().then(() => grokWake.notify(store.syncHumanRequests())).catch(() => {}).finally(() => { relayPending = null; });
      return relayPending;
    };
    // Gathering questions and waking an external bot does not call a model or
    // acknowledge delivery. Grok must actually relay each question first.
    store.syncHumanRequests();
    relayTimer = setInterval(relayTick, options.relayIntervalMs ?? 15000);
    relayTimer.unref?.();
    void relayTick();
    runner = createTaskRunner({ store, ...options.runner });
    grok = createGrokManagement({ store, onChange: () => runner.kick().catch(() => {}), ...options.grok });
    const report = createQwenWatchReport({ projectPath: options.watch?.projectPath || projectPath });
    watch = createQwenWatch({ store, projectPath, runtimeReader: () => runner.status(), qwenClient: options.runner?.qwenClient,
      quotaReader: () => { const grokQuota = readGrokQuota(projectPath); return { ...options.runner?.quotaReader?.(), grok: grokQuota.value, grokError: grokQuota.error }; },
      readReport: () => report.read(), publishReport: value => report.publish(value), ...options.watch });
    huddle = createQwenHuddle({ store, runtimeReader: () => {
      const runtime = runner.status(), connected = grok.status().connected || presence.status().connected;
      return { ...runtime, providers: { ...runtime.providers, grok: { available: connected, authenticated: connected } } };
    }, quotaReader: options.runner?.quotaReader,
      qwenClient: options.huddle?.qwenClient || options.runner?.qwenClient || options.watch?.qwenClient,
      providerConcurrency: options.runner?.providerConcurrency, onDispatch: () => runner.kick(), ...options.huddle });
    const bridge = taskBoardBridge({ store, grokWake, onInstruction: () => grok.kick(), onTaskChange: async () => { await relayTick(); return runner.kick(); }, getRuntimeStatus: () => ({...runner.status(), commandInterface}), getWatchStatus: () => watch.status(), getHuddleStatus: () => huddle.status(), getGrokStatus: () => { const api=grok.status(),bot=presence.status(); return {...api,apiConnected:api.connected,apiError:api.error,error:bot.connected?null:api.error,bot,connected:api.connected||bot.connected,agents:[...api.agents,...bot.agents]}; }, onBotHeartbeat: input => presence.heartbeat(input), onConfigureGrok: input => grok.connect(input) });
    bridge.configureServer(server);
    void Promise.allSettled([runner.start(), grok.start(), watch.start()]).then(() => { if (!stopping) huddle.start(); });
    server.httpServer?.once('close', stop);
  }
  return { name: 'ai-office-services', configureServer: install, configurePreviewServer: install, closeBundle: stop };
}
