import React from 'react'

// Optional effects must never take down the Canvas or the task-board UI.
// In particular, a stale Vite chunk can reject the lazy import after deploy.
export default class OptionalSceneEffects extends React.Component {
  state = { failed: false }

  static getDerivedStateFromError() {
    return { failed: true }
  }

  componentDidCatch(error) {
    console.warn('Office lighting effects unavailable; keeping the base scene.', error)
  }

  render() {
    return this.state.failed ? null : this.props.children
  }
}
