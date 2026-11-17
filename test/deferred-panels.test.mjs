import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createServer } from 'vite'

test('deferred scene and panels show accessible loading and failure routes in both languages', async () => {
  const cacheDir = await mkdtemp(path.join(tmpdir(), 'office-deferred-render-'))
  const vite = await createServer({ cacheDir, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' })
  try {
    const { setLang } = await vite.ssrLoadModule('/src/i18n.js')
    const { default: SceneRecovery } = await vite.ssrLoadModule('/src/SceneRecovery.jsx')
    const { default: LazyPanel } = await vite.ssrLoadModule('/src/LazyPanel.jsx')
    for (const lang of ['en', 'zh']) {
      setLang(lang)
      for (const Boundary of [SceneRecovery, LazyPanel]) {
        // A module download which has not completed must leave an actionable
        // task entry, while the parent app continues to own its state.
        const props = { load: () => new Promise(() => {}), onTasks() {}, onDirectory() {} }
        const loading = renderToStaticMarkup(React.createElement(Boundary, props))
        assert.match(loading, /role="status"/)
        assert.match(loading, lang === 'en' ? /Loading/ : /正在加载/)
        assert.match(loading, lang === 'en' ? /Open task board/ : /打开任务板/)
        const boundary = new Boundary(props)
        boundary.state = { ...boundary.state, ...Boundary.getDerivedStateFromError(new Error('Fixture import failed')) }
        const failed = renderToStaticMarkup(boundary.render())
        assert.match(failed, lang === 'en' ? /could not load/ : /无法/)
        assert.match(failed, lang === 'en' ? /Retry/ : /重试/)
        assert.match(failed, lang === 'en' ? /Open task board/ : /打开任务板/)
        assert.doesNotMatch(failed, /Fixture import failed/)
        assert.doesNotMatch(failed, /Reload page|重新载入页面/, 'first failure offers a local retry without reloading the app')
        boundary.state = { failed: false, attempt: 1 }
        const retrying = renderToStaticMarkup(boundary.render())
        assert.match(retrying, lang === 'en' ? /Loading/ : /正在加载/)
        assert.doesNotMatch(retrying, /Reload page|重新载入页面/, 'an in-flight retry does not offer or trigger a reload')
        boundary.state = { failed: true, attempt: 1 }
        const retryFailed = renderToStaticMarkup(boundary.render())
        assert.match(retryFailed, lang === 'en' ? />Reload page<\/button>/ : />重新载入页面<\/button>/)
        assert.match(retryFailed, lang === 'en' ? /unsent input may be lost/ : /未提交的输入可能丢失/)
        assert.match(retryFailed, lang === 'en' ? /Open task board/ : /打开任务板/)
      }
    }
  } finally { await vite.close(); await rm(cacheDir, { recursive: true, force: true }) }
})
