import { defineConfig } from 'vite';
import { claudeBridge } from './server/claude-bridge.mjs';
import { officeServices } from './server/office-services.mjs';
import { usageBridge, createConfiguredUsage } from './server/usage-bridge.mjs';
import { codexBridge } from './server/codex-bridge.mjs';
import { loadOfficeConfig } from './server/office-config.mjs';
import { createLocalQwen } from './server/local-qwen.mjs';

export default defineConfig(() => {
  const configuration = loadOfficeConfig();
  const enabled = id => configuration.mode === 'enabled' && configuration.providers[id]?.enabled === true;
  const qwen = createLocalQwen({ enabled: enabled('local-qwen'), baseUrl: configuration.ollama.url,
    model: configuration.ollama.model || undefined, timeZone: configuration.timeZone,
    usageFile: `${configuration.dataDir}/local-qwen-usage.json` });
  const usage = createConfiguredUsage(configuration, qwen);
  return {
    cacheDir: '.cache/vite',
    optimizeDeps: { entries: ['index.html'], include: ['@react-three/postprocessing', 'postprocessing'] },
    plugins: [claudeBridge({ enabled: enabled('claude') }), codexBridge({ enabled: enabled('codex') }),
      officeServices({ configuration, qwenClient: qwen, runner: { quotaReader: usage.quotaReader }, watch: { usageReader: usage.reader }, onStop: usage.stop }),
      usageBridge({ reader: usage.reader }), { name: 'office-usage-cleanup', closeBundle: usage.stop }],
    server: { host: '127.0.0.1', strictPort: true },
    preview: { host: '127.0.0.1', strictPort: true },
  };
});
