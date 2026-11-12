import { createStoryStudio } from './story-studio.mjs';
import { readProjectCatalog } from './project-catalog.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createAgentPresence } from './agent-presence.mjs';
import { createGrokBotPresence } from './grok-bot-presence.mjs';
import { createTaskStore } from './task-store.mjs';
import { createTaskRunner } from './task-runner.mjs';
import { createGrokManagement } from './grok-management.mjs';
import { taskBoardBridge } from './task-board-bridge.mjs';
import { createQwenWatch } from './qwen-watch.mjs';
import { createQwenDuty } from './qwen-duty.mjs';
import { createNativeStatusReader } from './native-status-reader.mjs';
import { createQwenWatchReport } from './qwen-watch-report.mjs';
import { createQwenWorkReports } from './qwen-work-reports.mjs';
import { readGrokQuota } from './usage-bridge.mjs';
import { createQwenHuddle } from './qwen-huddle.mjs';
import { createGrokWake } from './grok-wake.mjs';
import { createLocalQwen, localQwen } from './local-qwen.mjs';
import { createGrokBlockedPatrol } from './grok-blocked-patrol.mjs';
import { readGrokPatrolConfig } from './grok-patrol-config.mjs';
import { createQwenDailyReport } from './qwen-daily-report.mjs';
import { pausedOfficeServices, acquireOfficeLock, stoppedService } from './portable-runtime.mjs';
import { configureWatchHolds } from './watch-task-policy.mjs';
import { publicOfficeConfig } from './office-config.mjs';
import { readClaudeStatus } from './claude-bridge.mjs';
import { readCodexStatus } from './codex-bridge.mjs';

// The same local services back development and preview. No workers are started
// by a production build or by importing the configuration.
export function officeServices(options = {}) {
  const configuration = options.configuration;
  if (configuration && configuration.mode !== 'enabled') return pausedOfficeServices(configuration);
  const enabled = id => !configuration || configuration.providers[id]?.enabled === true;
  if (configuration) {
    // Share generation state with usage and every resident duty. A second client
    // would report an idle assistant while the actual local worker is busy.
    // The enabled configuration is authoritative even for an injected shared client.
    const injectedQwenClient = options.qwenClient || options.runner?.qwenClient;
    const qwenClient = enabled('local-qwen') && injectedQwenClient || createLocalQwen({ enabled: enabled('local-qwen'), baseUrl: configuration.ollama.url,
      model: configuration.ollama.model || undefined, timeZone: configuration.timeZone,
      usageFile: path.join(configuration.dataDir, 'local-qwen-usage.json') });
    options = { ...options,
      store: { ...options.store, home: configuration.dataDir, researchDir: path.join(configuration.dataDir, 'research'), autoPickup: false, reviewerFor: configuration.reviewerFor },
      runner: { ...options.runner, providers: configuration.providers, routing: configuration.routing, qwenClient },
      watch: { prerequisiteIds: [], ...options.watch, projectPath: configuration.dataDir, qwenClient },
      workReports: { prerequisiteIds: [], ...options.workReports, qwenClient },
      huddle: { ...options.huddle, qwenClient, providers: configuration.providers, routing: configuration.routing, reviewerFor: configuration.reviewerFor },
    };
  }
  let releaseLock;
  let store, runner, grok, watch, huddle, workReports, duty, dailyReports, reportWake, grokPatrol, patrolWake, storyStudio, grokWake, dispatchWake, relayTimer, relayPending, stopping;
  async function stop() {
    if (stopping) return stopping;
    stopping = (async () => {
      clearInterval(relayTimer);
      await grokWake?.stop();
      await dispatchWake?.stop();
      await reportWake?.stop();
      await patrolWake?.stop();
      await relayPending;
      const dutyStopped = duty?.stop();
      await Promise.allSettled([watch?.stop(), huddle?.stop(), workReports?.stop(), dailyReports?.stop(), grokPatrol?.stop(), storyStudio?.stop(), dutyStopped]);
      await Promise.allSettled([runner?.stop(), grok?.stop()]);
      store?.close?.();
      releaseLock?.();
      options.onStop?.();
    })();
    return stopping;
  }
  function install(server) {
    if (configuration) configureWatchHolds(configuration.pausedTaskIds);
    if (configuration) releaseLock = acquireOfficeLock(configuration.dataDir);
    try { store = createTaskStore(options.store); } catch (error) { releaseLock?.(); throw error; }
    const presence = createGrokBotPresence();
    const agentPresence = createAgentPresence();
    const projectPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const reportRoot = options.workReports?.projectPath || options.watch?.projectPath || projectPath;
    const isDefaultProject = reportRoot === projectPath;
    const nativeStatusUrl = options.nativeStatusUrl || process.env.AI_OFFICE_NATIVE_STATUS_URL;
    const commandInterface = { projectPath, scriptPath:path.join(projectPath,'scripts','office-board.mjs'), commands:['status','blocked-tasks','handle-blocked-task','pending-reports','acknowledge-report','pending-questions','triage-question','acknowledge-question','answer-question','pending-instructions','add-task','add-role','apply-plan','bot-heartbeat','agent-heartbeat','claim','claim-next','heartbeat','finish'] };
    grokWake = enabled('grok-bot') ? createGrokWake({ home: options.store?.home, ...options.grokWake }) : { ...stoppedService({ configured: false }), notify: () => {} };
    const makeDispatchWake = () => enabled('grok-bot') ? createGrokWake({ home: options.store?.home, ...options.grokWake, channel: 'instructions', commandInterface, officeUrl: () => { const address = server.httpServer?.address?.(); return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null; } }) : { ...stoppedService({ configured: false }), notify: () => {}, delivery: () => ({}) };
    dispatchWake = makeDispatchWake();
    const makeReportWake = () => enabled('grok-bot') ? createGrokWake({ home: options.store?.home, ...options.grokWake, channel: 'reports', commandInterface, officeUrl: () => { const address = server.httpServer?.address?.(); return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null; } }) : { ...stoppedService({ configured: false }), notify: () => {}, delivery: () => ({}) };
    reportWake = makeReportWake();
    const makePatrolWake = () => enabled('grok-bot') ? createGrokWake({ home: options.store?.home, ...options.grokWake, channel: 'blocked', commandInterface, officeUrl: () => { const address = server.httpServer?.address?.(); return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null; } }) : { ...stoppedService({ configured: false }), notify: () => ({ configured: false }) };
    patrolWake = makePatrolWake();
    const relayTick = () => {
      if (stopping || relayPending) return relayPending;
      relayPending = Promise.resolve().then(async () => { await grokWake.notify(store.syncHumanRequests()); if (!grok?.status().connected) await dispatchWake.notify(store.snapshot().instructions); }).catch(() => {}).finally(() => { relayPending = null; });
      return relayPending;
    };
    // Gathering questions and waking an external bot does not call a model or
    // acknowledge delivery. Grok must actually relay each question first.
    store.syncHumanRequests();
    relayTimer = setInterval(relayTick, options.relayIntervalMs ?? 15000);
    relayTimer.unref?.();
    void relayTick();
    runner = createTaskRunner({ store, onLog: entry => workReports?.recordLog?.(entry), ...options.runner, onChange: value => { options.runner?.onChange?.(value); duty?.notify(value); }, ...(configuration ? { officeUrl: () => {
      const address = server.httpServer?.address?.();
      return address && typeof address === 'object' ? `http://127.0.0.1:${address.port}` : null;
    } } : {}) });
    grok = configuration ? stoppedService({ configured: false }) : createGrokManagement({ store, onChange: () => runner.kick().catch(() => {}), ...options.grok });
    const report = createQwenWatchReport({ projectPath: options.watch?.projectPath || projectPath });
    watch = !enabled('local-qwen') ? stoppedService() : createQwenWatch({ store, projectPath, runtimeReader: () => runner.status(), qwenClient: options.runner?.qwenClient,
      quotaReader: () => { const grokQuota = readGrokQuota(configuration?.dataDir || projectPath); return { ...options.runner?.quotaReader?.(), grok: grokQuota.value, grokError: grokQuota.error }; },
      readReport: () => report.read(), publishReport: value => report.publish(value), ...options.watch });
    huddle = !enabled('local-qwen') ? stoppedService() : createQwenHuddle({ store, runtimeReader: () => {
      const runtime = runner.status(), connected = grok.status().connected || presence.status().connected;
      return { ...runtime, providers: { ...runtime.providers, grok: { available: connected, authenticated: connected } } };
    }, quotaReader: options.runner?.quotaReader,
      qwenClient: options.huddle?.qwenClient || options.runner?.qwenClient || options.watch?.qwenClient,
      providerConcurrency: options.runner?.providerConcurrency, onDispatch: () => runner.kick(), ...options.huddle });
    const patrolConfig = readGrokPatrolConfig(options.store?.home);
    grokPatrol = createGrokBlockedPatrol({ store, home: options.store?.home, enabled: enabled('grok-bot') && patrolConfig.enabled, intervalMs: patrolConfig.intervalMs,
      runtimeReader: () => runner.status(), quotaReader: options.runner?.quotaReader, providerConcurrency: options.runner?.providerConcurrency, configuration, ...options.grokPatrol,
      notify: items => patrolWake.notify(items), onDispatch: () => runner.kick() });
    storyStudio = createStoryStudio({ store, home: options.store?.home, qwenClient: options.runner?.qwenClient || localQwen,
      runtimeReader: () => runner.status(), quotaReader: options.runner?.quotaReader, configuration, ...options.storyStudio, onTaskChange: () => runner.kick() });
    const getGrokPatrol = () => ({ ...grokPatrol.status(), ...(patrolConfig.error ? { error: patrolConfig.error } : {}), notification: patrolWake.status() });
    const getGrokCombined = () => { const api=grok.status(),bot=presence.status(); return {...api,apiConnected:api.connected,apiError:api.error,error:bot.connected?null:api.error,bot,connected:api.connected||bot.connected,agents:[...api.agents,...bot.agents]}; };
    workReports = !enabled('local-qwen') ? stoppedService({ providers: [], allTasks: [], runningLogs: [] }) : createQwenWorkReports({
      store,
      projectPath: reportRoot,
      qwenClient: options.workReports?.qwenClient || options.runner?.qwenClient,
      runtimeReader: () => runner.status(),
      watchReader: () => watch.status(),
      huddleReader: () => huddle.status(),
      grokReader: () => getGrokCombined(),
      claudeReader: (configuration ? enabled('claude') : isDefaultProject) ? (nativeStatusUrl ? createNativeStatusReader({ baseUrl: nativeStatusUrl, provider: 'claude' }) : () => readClaudeStatus()) : null,
      codexReader: (configuration ? enabled('codex') : isDefaultProject) ? (nativeStatusUrl ? createNativeStatusReader({ baseUrl: nativeStatusUrl, provider: 'codex' }) : () => readCodexStatus()) : null,
      ...options.workReports,
    });
    dailyReports = !enabled('local-qwen') ? { ...stoppedService({ enabled: false, phase: 'disabled', pendingCount: 0 }), pending: () => [] } : createQwenDailyReport({
      home: options.store?.home, store, qwenClient: options.workReports?.qwenClient || options.runner?.qwenClient || localQwen,
      allowedProjects: () => readProjectCatalog(options.store?.home), ...options.dailyReports, notify: items => reportWake.notify(items),
    });
    const getDailyReports = () => ({ ...dailyReports.status(), notification: reportWake.status(), notifications: reportWake.delivery(dailyReports.pending()) });
    duty = createQwenDuty({ store, runtimeReader: () => runner.status(), quotaReader: options.runner?.quotaReader, watch, huddle, workReports, ...options.duty, enabled: enabled('local-qwen') });
    const bridge = taskBoardBridge({ store, grokWake, getStoryStudio: () => storyStudio.status(), getGrokPatrol, getBlockedTasks: () => grokPatrol.pending(), onHandleBlockedTask: (id, input) => grokPatrol.handle(id, input), getDailyReports, getPendingReports: () => dailyReports.pending(), onAcknowledgeReport: enabled('local-qwen') ? (id, input) => dailyReports.acknowledge(id, input) : undefined, onWakeConfigured: async () => { await relayPending; dispatchWake.stop(); dispatchWake = makeDispatchWake(); await reportWake.stop(); reportWake = makeReportWake(); await patrolWake.stop(); patrolWake = makePatrolWake(); void dailyReports.tick?.(); void relayTick(); }, getDispatchStatus: () => ({ source: 'office-queue', privateChatMirrored: false, checkedAt: new Date().toISOString(), botConnected: presence.status().connected, plannerConnected: Boolean(grok.status().connected), notification: dispatchWake.status(), delivery: dispatchWake.delivery(store.snapshot().instructions) }), getProjectCatalog: () => readProjectCatalog(options.store?.home), ...(configuration ? { configuration: publicOfficeConfig(configuration), meetingFile: path.join(configuration.dataDir, 'reports/meetings/live.json'), enabledProviders: Object.keys(configuration.providers).filter(enabled), defaultProjectPath: configuration.workspace } : {}), onInstruction: async () => { await grok.kick(); await relayTick(); }, onTaskChange: async () => { duty.notify(); await relayTick(); return runner.kick(); }, getRuntimeStatus: () => { const state = runner.status(); return {...state, agents: [...(state.agents || []), ...agentPresence.agents()], commandInterface}; }, onAgentHeartbeat: input => agentPresence.heartbeat(input), getWatchStatus: () => ({ ...watch.status(), duty: duty.status() }), getHuddleStatus: () => huddle.status(), getWorkReports: () => workReports.status(), getGrokStatus: getGrokCombined, onBotHeartbeat: enabled('grok-bot') ? input => presence.heartbeat(input) : undefined, onConfigureGrok: configuration ? undefined : input => grok.connect(input) });
    bridge.configureServer(server);
    const start = () => {
      if (stopping) return;
      // Model report generation must not delay patrols or blocked-task ownership.
      void Promise.allSettled([runner.start(), grok.start(), watch.start(), huddle.start(), workReports.start(), dailyReports.start(), grokPatrol.start(), storyStudio.start()]);
      duty.start();
    };
    if (server.httpServer?.listening === false) server.httpServer.once('listening', start);
    else start();
    server.httpServer?.once('close', stop);
  }
  return { name: 'ai-office-services', configureServer: install, configurePreviewServer: install, closeBundle: stop };
}
