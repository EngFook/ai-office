import React, { Suspense, lazy } from 'react'
import { useLang } from './i18n'
import './scene-recovery.css'

function SceneFallback({ onRetry, onTasks, onDirectory, canReload = false }) {
  const zh = useLang() === 'zh'
  return <section className="scene-recovery" role="status" data-no-i18n>
    <div><span aria-hidden="true">◇</span><h3>{zh ? '3D 办公室暂时无法显示' : 'The 3D office could not load'}</h3>
      <p>{zh ? '任务板、Qwen 集结和调度台仍可继续使用。可以重试 3D，或直接打开任务列表。' : 'You can still use tasks, Qwen huddles and Dispatch. Retry the scene or open the task list directly.'}</p>
      {canReload && <p>{zh ? '局部重试仍失败，可重新载入页面。未提交的输入可能丢失，请先复制保存。' : 'Retry still failed. You can reload the page; unsent input may be lost, so copy it first.'}</p>}
      <div className="scene-recovery__actions"><button type="button" onClick={onTasks}>{zh ? '打开任务板' : 'Open task board'}</button><button type="button" onClick={onDirectory}>{zh ? '查看代理列表' : 'View agent list'}</button><button type="button" onClick={onRetry}>{zh ? '重试 3D' : 'Retry 3D'}</button>{canReload && <button type="button" onClick={() => window.location.reload()}>{zh ? '重新载入页面' : 'Reload page'}</button>}</div>
    </div>
  </section>
}

export function SceneLoading({ onTasks, onDirectory }) {
  const zh = useLang() === 'zh'
  return <section className="scene-recovery" role="status" aria-live="polite" data-no-i18n>
    <div><span aria-hidden="true">◇</span><h3>{zh ? '正在加载 3D 办公室…' : 'Loading the 3D office…'}</h3>
      <p>{zh ? '任务板已可使用，加载期间也可以直接查看任务或代理。' : 'Tasks are available while the scene loads. You can open the task board or agent list now.'}</p>
      <div className="scene-recovery__actions"><button type="button" onClick={onTasks}>{zh ? '打开任务板' : 'Open task board'}</button><button type="button" onClick={onDirectory}>{zh ? '查看代理列表' : 'View agent list'}</button></div>
    </div>
  </section>
}

// Keep a failed renderer or asset confined to the scene. Board state and user
// input live outside this boundary and are not reset when the scene is retried.
export default class SceneRecovery extends React.Component {
  constructor(props) { super(props); this.Scene = props.load ? lazy(props.load) : null }
  state = { failed: false, attempt: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { console.warn('AI Office 3D view unavailable; task controls remain available.') }
  retry = () => {
    // Reset React's rejected import on an explicit local retry. A browser may
    // still cache the failed module; after another failure offer a user-chosen
    // page reload rather than automatically discarding unsent input.
    if (this.props.load) this.Scene = lazy(this.props.load)
    this.setState(previous => ({ failed: false, attempt: previous.attempt + 1 }))
  }
  render() {
    return this.state.failed
      ? <SceneFallback onRetry={this.retry} onTasks={this.props.onTasks} onDirectory={this.props.onDirectory} canReload={this.state.attempt > 0}/>
      : <React.Fragment key={this.state.attempt}>{this.Scene ? <Suspense fallback={<SceneLoading onTasks={this.props.onTasks} onDirectory={this.props.onDirectory}/>}><this.Scene {...this.props.sceneProps}/>{this.props.children}</Suspense> : this.props.children}</React.Fragment>
  }
}
