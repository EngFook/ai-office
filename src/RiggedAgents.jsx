// STUB - V8a (worktree /tmp/aio-studio-3d-v8a) replaces this whole file with
// the instanced skinned-mesh renderer for the rigged Quaternius characters.
// Until that lands, the stub renders the primitive-figure fallback it is
// handed, so CharacterSwitch can mount unconditionally and the V8a merge is
// a plain file swap. The props contract the real renderer must honour is
// documented in reports/v8-interface.md:
//   agents       {layout, meeting, onArrived} behaviour source (as People uses)
//   getAgentClip (figure, nowMs) -> {clip, weight, fadeMs}
//   onSelect     (officeAgent) => void, on character click
//   onLoadError  (error) => void, on any character-asset load failure
//   fallback     React node with the primitive figures (stub-only usage)
export default function RiggedAgents({ fallback = null }) {
  return fallback
}
