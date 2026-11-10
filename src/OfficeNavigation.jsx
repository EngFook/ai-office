import React, { useEffect, useState } from 'react'
import { ArrowUpRight, Box, Map, MapPin, Maximize2, Minimize2, MoreHorizontal, RotateCcw, Search } from 'lucide-react'
import { REVIEWER_ROLES, SHARED_DEPARTMENTS } from './shared-layout'
import { officeDepartmentFocus } from './office-ui.js'
import './office-navigation.css'

const normalizeRole = value => typeof value === 'string' ? value.trim().replace(/\s+/g,' ').toLowerCase() : ''
const reviewerRoles = new Set(REVIEWER_ROLES.map(normalizeRole))
const isReviewer = agent => [agent.role,...(agent.runtimeAgents||[]).map(worker=>worker.agentRole)].some(role=>reviewerRoles.has(normalizeRole(role)))

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
        <optgroup label="Working teams">{departments.map((name,index)=><option key={name} value={officeDepartmentFocus(index)}>{name}</option>)}<option value="department-3">Specialist Reviewers</option><option value="department-6">Main Area</option></optgroup>
        <optgroup label="Shared spaces"><option value="meeting">Meeting room</option><option value="reception">Lounge & Coffee</option><option value="tasks">Task Board</option><option value="reports">Reports</option></optgroup>
      </select></label>
      <button onClick={()=>fullscreen?document.exitFullscreen():onFullscreen?.()}>{fullscreen?<Minimize2 size={15}/>:<Maximize2 size={15}/>}<span>{fullscreen?'Exit fullscreen':'Expand studio view'}</span></button>
      <p>Claude builds · Codex reviews & balances · Gemini researches · Grok dispatches</p>
    </div></details>
  </div>
}

// The same drawer shell in App hosts both room and agent details.
export function RoomDetails({ focus = 'overview', departments = SHARED_DEPARTMENTS, agents = [], assignmentCount = 0, reportCount = 0, pendingTaskCount = 0, onTasks, onManagement, onDirectory, onReports, quota }) {
  const [type,value]=focus.split('-'), index=Number(value), isDepartment=type==='department'
  const providerIndex=({0:0,1:1,2:2,4:3,5:4})[index]
  const department=departments[providerIndex]||({3:'Specialist Reviewers',6:'Main Area'}[index])
  const team=agents.filter(person=>person.liveStatus==='working' && (index===6 ? true : index===3 ? isReviewer(person) : person.department===department))
  const reviewers=team.filter(isReviewer).length
  const title=isDepartment?department:({meeting:'Meeting room',reception:'Lounge & Coffee',lounge:'Lounge & Coffee',tasks:'Task Board',reports:'Reports'})[focus]||'Studio'
  const description=isDepartment?({0:'Claude develops features and implements the team’s requests.',1:'Codex reviews, balances and provides release sign-off.',2:'Grok plans requests and dispatches work to the team.',3:'Gemini researches and provides read-only research reports.',4:'Qwen helps with logs, copy and CHANGELOG checks. Preliminary suggestions only.'})[providerIndex]||'Working agents in the main area.':({meeting:'A shared space for team discussions.',reception:'A place to pause between tasks.',lounge:'A place to pause between tasks.',tasks:'Requests are picked up by available agents.',reports:'Reports and notes, together in one place.'})[focus]
  const action=isDepartment?(index===2?onManagement:()=>onDirectory?.(index===3||index===6?undefined:department)):focus==='tasks'?onTasks:focus==='reports'?onReports:onDirectory
  const actionLabel=isDepartment?(index===2?'Dispatch via Grok':'Find agent'):focus==='tasks'?'Open task board':focus==='reports'?'Open reports':'Find agent'
  return <div className="room-details drawer-room">
    <span className="section-kicker">Room details</span><h2>{title}</h2>
    <div className="drawer-section"><h3>Status</h3><p><span aria-hidden="true">● </span>{team.length} working</p>{reviewers>0&&<p>{reviewers} specialist reviewers</p>}{quota}</div>
    <div className="drawer-section"><h3>Current task</h3><p>{description}</p>{focus==='tasks'&&<p>{pendingTaskCount} to do</p>}</div>
    <div className="drawer-section"><h3>Permissions</h3><span className="permission-badge">{providerIndex>=3?'Read-only':'Assigned project only'}</span></div>
    <div className="drawer-section"><h3>Reports</h3><p>{reportCount} saved reports · {assignmentCount} shared projects</p></div>
    <button className="primary-button drawer-primary" onClick={action}>{actionLabel}<ArrowUpRight size={15}/></button>
  </div>
}
