import React, { Suspense, lazy } from 'react'
import { useLang } from './i18n'

export function PanelStatus({ failed = false, onRetry, onTasks, canReload = false }) {
  const zh = useLang() === 'zh'
  return <section className="scene-recovery" role="status" aria-live="polite" data-no-i18n>
    <div><h3>{failed ? (zh ? '暂时无法加载此面板' : 'This panel could not load') : (zh ? '正在加载面板…' : 'Loading panel…')}</h3>
      <p>{zh ? '任务记录仍可在任务板中查看。' : 'Your task records remain available on the task board.'}</p>
      {failed && canReload && <p>{zh ? '局部重试仍失败，可重新载入页面。未提交的输入可能丢失，请先复制保存。' : 'Retry still failed. You can reload the page; unsent input may be lost, so copy it first.'}</p>}
      <div className="scene-recovery__actions"><button type="button" onClick={onTasks}>{zh ? '打开任务板' : 'Open task board'}</button>{failed && <button type="button" onClick={onRetry}>{zh ? '重试' : 'Retry'}</button>}{failed && canReload && <button type="button" onClick={() => window.location.reload()}>{zh ? '重新载入页面' : 'Reload page'}</button>}</div>
    </div>
  </section>
}

// This boundary encloses only the deferred page, never the app or its board.
export default class LazyPanel extends React.Component {
  constructor(props) { super(props); this.Panel = lazy(props.load) }
  state = { failed: false, attempt: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { console.warn('AI Office panel unavailable; task controls remain available.') }
  // Reset React's lazy cache first; a browser-cached failure may need an
  // explicit page reload. Never reload automatically or discard input on retry.
  retry = () => { this.Panel = lazy(this.props.load); this.setState(previous => ({ failed: false, attempt: previous.attempt + 1 })) }
  render() {
    return this.state.failed ? <PanelStatus failed onRetry={this.retry} onTasks={this.props.onTasks} canReload={this.state.attempt > 0}/>
      : <Suspense key={this.state.attempt} fallback={<PanelStatus onTasks={this.props.onTasks}/>}><this.Panel {...this.props.panelProps}/></Suspense>
  }
}
