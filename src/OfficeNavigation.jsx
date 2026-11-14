import { StoryStudioStatus } from './StoryStudioStatus'
import React, { useEffect, useState } from 'react'
import { ArrowUpRight, Box, Map, MapPin, Maximize2, Minimize2, MoreHorizontal, RotateCcw, Search } from 'lucide-react'
import { grokUnblockingRole, SHARED_DEPARTMENTS } from './shared-layout'
import { useLang, t } from './i18n'
import { useOfficeDate } from './OfficeIdentity'
import { officeDepartmentFocus, officeActivityCounts } from './office-ui.js'
import { officeExecutionCounts, officeRuntimeWorkers } from './claude-execution.js'
import './office-navigation.css'

export function OfficeToolbar({ departments = SHARED_DEPARTMENTS, focus = 'overview', onFocus, mode, onMode, onDirectory, onReset, onFullscreen }) {
  const [fullscreen,setFullscreen]=useState(!!document.fullscreenElement)
  useEffect(()=>{
    const onChange=()=>setFullscreen(!!document.fullscreenElement)
    document.addEventListener('fullscreenchange',onChange)
    return()=>document.removeEventListener('fullscreenchange',onChange)
  },[])
  return <div className="office-toolbar" aria-label="Studio controls">
    <div className="camera-modes" aria-label="Camera view">
      <button aria-pressed={mode==='3d'} onClick={()=>onMode?.('3d')}><Box size={14}/> 3D</button>
      <button aria-pressed={mode==='plan'} onClick={()=>onMode?.('plan')}><Map size={14}/> Map</button>
    </div>
    <button className="find-agent-button" onClick={onDirectory}><Search size={14}/><span>Find agent</span></button>
    <button className="toolbar-reset" aria-label="Reset view" onClick={onReset}><RotateCcw size={14}/><span>Reset view</span></button>
    <details className="toolbar-more"><summary aria-label="More"><MoreHorizontal size={16}/><span>More</span></summary><div className="toolbar-menu">
      <label className="room-picker"><MapPin size={16}/><select aria-label="Explore the shared studio" value={focus.startsWith('agent-')?'overview':focus} onChange={event=>onFocus?.(event.target.value)}>
        <option value="overview">Studio</option>
        <optgroup label="Working teams">{departments.map((name,index)=><option key={name} value={officeDepartmentFocus(index)}>{name}</option>)}<option value="department-3">Grok Unblocking</option><option value="department-6">Main Area</option></optgroup>
        <optgroup label="Shared spaces"><option value="meeting">Meeting room</option><option value="reception">Lounge & Coffee</option><option value="tasks">Task Board</option><option value="reports">Reports</option></optgroup>
      </select></label>
      <button onClick={()=>fullscreen?document.exitFullscreen():onFullscreen?.()}>{fullscreen?<Minimize2 size={15}/>:<Maximize2 size={15}/>}<span>{fullscreen?'Exit fullscreen':'Expand studio view'}</span></button>
      <p>Claude builds · Codex reviews & balances · Gemini researches · Grok dispatches</p>
    </div></details>
  </div>
}

// Timer activity and accepted wake-ups are not evidence that Grok handled a task.
export function GrokPatrolStatus({ state }) {
  useLang()
  const dateLabel=useOfficeDate({ month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', timeZoneName:'short' })
  const enabled=state?.enabled===true
  const handled=state?.lastHandledAt && Number.isFinite(new Date(state.lastHandledAt).getTime())
  const result=typeof state?.lastResult==='string' ? state.lastResult : state?.lastResult&&!Array.isArray(state.lastResult)&&typeof state.lastResult.reason==='string' ? state.lastResult.reason : ''
  const interval=Number.isFinite(state?.intervalMs)&&state.intervalMs>0 ? Math.round(state.intervalMs/60000*10)/10 : null
  return <section className="drawer-section" aria-label={t('Blocked task patrol')} data-no-i18n>
    <h3>{t('Blocked task patrol')}</h3>
    <p><strong>{t(state?enabled?'Enabled':'Disabled':'Waiting for service status')}</strong>{enabled&&interval!==null&&<> · {t('Every {n} minutes').replace('{n}',String(interval))}</>}</p>
    {enabled&&state.phase==='awaiting_bot'&&<p role="status">{t('Grok check requested; awaiting an actual response.')}</p>}
    {enabled&&state.started===false&&<p>{t('Patrol service has not started.')}</p>}
    <p>{t('Last handled by Grok:')} {handled?dateLabel(state.lastHandledAt):t('No result written back yet')}</p>
    {handled&&result.trim()&&<p>{result}</p>}
    <p>{t('Next check:')} {enabled&&state.started===true?dateLabel(state.nextCheckAt):'—'}</p>
    {typeof state?.error==='string'&&state.error&&<p role="alert">{t('Patrol needs attention:')} {state.error}</p>}
  </section>
}

// The same drawer shell in App hosts both room and agent details.
export function RoomDetails({ focus = 'overview', departments = SHARED_DEPARTMENTS, agents = [], assignmentCount = 0, reportCount = 0, pendingTaskCount = 0, onTasks, onBlockedTasks, onManagement, onDirectory, onReports, quota, grokPatrol, storyStudio }) {
  const zh=useLang()==='zh'
  const [type,value]=focus.split('-'), index=Number(value), isDepartment=type==='department'
  const providerIndex=({0:0,1:1,2:2,4:3,5:4})[index]
  const department=departments[providerIndex]||({3:'Grok Unblocking',6:'Main Area'}[index])
  const team=agents.filter(person=>(index===3?person.liveStatus!=='offline':person.liveStatus==='working') && (index===6 ? true : index===3 ? grokUnblockingRole(person) : person.department===department && !grokUnblockingRole(person)))
  const activity=officeActivityCounts(team)
  const unknown=index===3?officeExecutionCounts(officeRuntimeWorkers(team)).unconfirmed:0
  const title=isDepartment?department:({meeting:'Meeting room',reception:'Lounge & Coffee',lounge:'Lounge & Coffee',tasks:'Task Board',reports:'Reports'})[focus]||'Studio'
  const description=isDepartment?index===3?'Grok investigates blockers, coordinates the right owners and follows recovery through to completion. Questions needing your information or approval are relayed to you.':({0:'Claude develops features and implements the team’s requests.',1:'Codex reviews, balances and provides release sign-off.',2:'Grok plans requests and dispatches work to the team.',3:'Gemini researches and provides read-only research reports.',4:'Qwen checks blocked tasks, matches owners by capability and quota, and follows up on investigations. Questions needing your information or approval go through Grok.'})[providerIndex]||'Working agents in the main area.':({meeting:'A shared space for team discussions.',reception:'A place to pause between tasks.',lounge:'A place to pause between tasks.',tasks:'Requests are picked up by available agents.',reports:'Reports and notes, together in one place.'})[focus]
  const action=isDepartment?(index===3?onBlockedTasks:index===2?onManagement:()=>onDirectory?.(index===6?undefined:department)):focus==='tasks'?onTasks:focus==='reports'?onReports:onDirectory
  const actionLabel=isDepartment?(index===3?'Open blocked tasks':index===2?'Dispatch via Grok':'Find agent'):focus==='tasks'?'Open task board':focus==='reports'?'Open reports':'Find agent'
  return <div className="room-details drawer-room">
    <span className="section-kicker">Room details</span><h2>{title}</h2>
    <div className="drawer-section"><h3>Status</h3>{isDepartment&&index!==6&&<p>Team total, including overflow desks</p>}<p data-no-i18n><span aria-hidden="true">● </span>{activity.confirmed} {zh?'运行中':'running'} · {activity.recorded+unknown} {index===3?(zh?'状态待确认':'unconfirmed'):(zh?'活动待确认':'activity records · unconfirmed')}</p>{quota}</div>
    {isDepartment&&index===3&&<GrokPatrolStatus state={grokPatrol}/>}{isDepartment&&[4,5].includes(index)&&<StoryStudioStatus state={storyStudio}/>}
    <div className="drawer-section"><h3>Current task</h3><p>{description}</p>{focus==='tasks'&&<p>{pendingTaskCount} to do</p>}</div>
    <div className="drawer-section"><h3>Permissions</h3><span className="permission-badge">{providerIndex>=3?'Read-only':'Assigned project only'}</span></div>
    <div className="drawer-section"><h3>Reports</h3><p>{reportCount} saved reports · {assignmentCount} shared projects</p></div>
    <button className="primary-button drawer-primary" onClick={action}>{actionLabel}<ArrowUpRight size={15}/></button>
    {isDepartment&&index===3&&<button className="primary-button drawer-primary" onClick={onManagement}>Dispatch via Grok<ArrowUpRight size={15}/></button>}
  </div>
}
