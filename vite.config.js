import { defineConfig } from 'vite';
import { claudeBridge } from './server/claude-bridge.mjs';
import { officeServices } from './server/office-services.mjs';
import { usageBridge, sharedQuota, createUsageReader } from './server/usage-bridge.mjs';
import { codexBridge } from './server/codex-bridge.mjs';

const usageReader = createUsageReader();

export default defineConfig({
  // SSR render tests use their own temporary caches. Keep the live server out
  // of Vite's default cache too, so a test cannot invalidate browser chunks.
  cacheDir: 'node_modules/.vite-office',
  optimizeDeps: { include: ['@react-three/postprocessing', 'postprocessing'] },
  plugins:[claudeBridge(),codexBridge(),officeServices({runner:{quotaReader:sharedQuota},watch:{usageReader}}),usageBridge({reader:usageReader})],
  server:{host:'127.0.0.1'},
  preview:{host:'127.0.0.1'},
});
