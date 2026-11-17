import { createPollingResource } from './polling-resource.js';

export function createUsageDataStore(options = {}) {
  return createPollingResource({ url: '/api/usage', errorMessage: 'Usage data unavailable',
    validate: data => data !== null && typeof data === 'object' && Array.isArray(data.providers)
      && data.providers.every(provider => provider && typeof provider.provider === 'string'
        && (provider.models === undefined || Array.isArray(provider.models))),
    ...options });
}
export const usageDataStore = createUsageDataStore();
