import React from 'react'
import { useLang } from './i18n'
import { useOfficeDate } from './OfficeIdentity'

export function StoryStudioStatus({ state }) {
  const zh=useLang()==='zh'
  const date=useOfficeDate({ month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })
  const labels={disabled:['未启用','Disabled'],stopped:['已停止','Stopped'],waiting:['等待下一步','Waiting'],paused:['暂停推进','Paused'],researching:['Gemini 研究与构思','Gemini researching'],drafting:['Qwen 正在写候选稿','Qwen drafting'],reviewing:['Gemini 正在审稿','Gemini editing'],revising:['Qwen 正在修改','Qwen revising'],cooldown:['等待冷却或额度恢复','Waiting for cooldown or quota'],blocked:['需要处理阻塞','Needs attention'],idle:['等待下轮创作','Waiting for next cycle'],ready:['候选稿已保存','Candidate saved']}
  const label=(state?.enabled&&state?.busy!==true&&['researching','drafting','reviewing','revising'].includes(state.phase)?(zh?'等待该阶段执行':'Waiting for this stage to run'):labels[state?.phase]?.[zh?0:1]) || (state?.enabled?(zh?'创作流程已启用':'Writing workflow enabled'):(zh?'等待创作服务状态':'Waiting for writing service'))
  return <section className="drawer-section" aria-label={zh?'退界剧情工坊':'Walkalone story studio'} data-no-i18n>
    <h3>{zh?'退界剧情工坊':'Walkalone story studio'}</h3>
    <p>{zh?'Gemini：研究、构思、审稿 · Qwen：主笔、修稿':'Gemini: research, ideas, editing · Qwen: drafts and revisions'}</p>
    <p><strong>{label}</strong></p>
    {typeof state?.currentStage==='string'&&state.currentStage&&<p>{state.currentStage}</p>}{typeof state?.reason==='string'&&state.reason&&<p>{state.reason}</p>}
    {typeof state?.error==='string'&&state.error&&<p role="alert">{state.error}</p>}
    {state?.enabled&&<p>{zh?'下次检查：':'Next check: '}{date(state.nextCheckAt)}</p>}
    <p>{zh?'最近成稿：':'Last draft: '}{state?.lastCompletedAt?date(state.lastCompletedAt):(zh?'尚无完成记录':'No completed draft yet')}</p>
    {typeof state?.draftPreview==='string'&&state.draftPreview&&<details><summary>{zh?'查看最近候选稿':'Read latest candidate'}</summary><p style={{whiteSpace:'pre-wrap',maxHeight:280,overflowY:'auto'}}>{state.draftPreview}</p></details>}
    <small>{zh?'候选稿单独保存；定稿后再纳入游戏剧情。':'Candidates are saved separately before adoption into the game.'}</small>
  </section>
}
