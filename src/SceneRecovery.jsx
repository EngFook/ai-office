import React from 'react'
import { useLang } from './i18n'
import './scene-recovery.css'

function SceneFallback({ onRetry, onTasks, onDirectory }) {
  const zh = useLang() === 'zh'
  return <section className="scene-recovery" role="status" data-no-i18n>
    <div><span aria-hidden="true">◇</span><h3>{zh ? '3D 办公室暂时无法显示' : 'The 3D office could not load'}</h3>
      <p>{zh ? '任务板、Qwen 集结和调度台仍可继续使用。可以重试 3D，或直接打开任务列表。' : 'You can still use tasks, Qwen huddles and Dispatch. Retry the scene or open the task list directly.'}</p>
      <div className="scene-recovery__actions"><button type="button" onClick={onTasks}>{zh ? '打开任务板' : 'Open task board'}</button><button type="button" onClick={onDirectory}>{zh ? '查看代理列表' : 'View agent list'}</button><button type="button" onClick={onRetry}>{zh ? '重试 3D' : 'Retry 3D'}</button></div>
    </div>
  </section>
}

// Keep a failed renderer or asset confined to the scene. Board state and user
// input live outside this boundary and are not reset when the scene is retried.
export default class SceneRecovery extends React.Component {
  state = { failed: false, attempt: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch() { console.warn('AI Office 3D view unavailable; task controls remain available.') }
  retry = () => this.setState(previous => ({ failed: false, attempt: previous.attempt + 1 }))
  render() {
    return this.state.failed
      ? <SceneFallback onRetry={this.retry} onTasks={this.props.onTasks} onDirectory={this.props.onDirectory}/>
      : <React.Fragment key={this.state.attempt}>{this.props.children}</React.Fragment>
  }
}
