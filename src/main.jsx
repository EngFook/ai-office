import { requestId } from './request-id.js';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ArrowRight, ArrowUpRight, Box, BriefcaseBusiness, Check, ChevronRight, ClipboardList, FileText, FolderGit2, LayoutDashboard, Plus, UsersRound, X } from 'lucide-react';
import OfficeScene from './OfficeScene';
import { OfficeToolbar, RoomDetails } from './OfficeNavigation';
import { AgentActivity, AgentStatusPanel, SharedConnections, useClaudeConnection, useCodexConnection } from './ClaudeConnection';
import { claudeAgentStatus } from './claude-office';
import { SHARED_DEPARTMENTS, buildSharedRoster, codexOfficeRole, resolveSharedSelection, migrateOfficeRecords, workingOfficeAgents, withTaskWorkers, officeRoleLabel, officeRoleDescription, officeAgentLabel } from './unified-office';
import { taskMatchesAgent, findTaskAgent, modelReadiness, officeDepartmentFocus, roomProvider, localQwenConnection, connectedProviderResidents } from './office-ui.js';
import { taskProjects } from './task-board-ui.js';
import TaskBoard, { useTaskBoard, TaskBoardSummary, TaskProjects } from './TaskBoard';
import WorkReports from './WorkReports';
import UsagePanel, { QuotaIndicator, AgentQuota } from './UsagePanel';
import QwenWatchNotice from './QwenWatchNotice';
import { installDomTranslator, setLang, useLang, uiLocale, t } from './i18n';
import './style.css';
import './shared-office.css';

const PROVIDER_COLORS = {'Claude Code':'#eda47f',Codex:'#68d7b0',Grok:'#a99af5',Gemini:'#8fa9d6','Local Qwen':'#c4b06d'};
const ROOM_DESCRIPTIONS = [
  'Four round tables with five seats each, arranged in two airy rows.',
  'Codex reviews, balances and provides release sign-off.',
  'Grok plans requests and dispatches work to the team.',
  'Gemini researches and provides read-only research reports.',
  'Qwen helps with logs, copy and CHANGELOG checks. Preliminary suggestions only.',
];
const GROK = {agents:[],skills:[],connected:false,loading:false,error:null};
const STATUSES = ['Planned','In progress','Blocked','Done'];
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const savedRecords = kind => migrateOfficeRecords(read(`office-${kind}-v2`, read(`office-${kind}-v1`, [])));
const providerLetter = provider => ({'Claude Code':'C',Codex:'X',Grok:'G',Gemini:'M','Local Qwen':'Q'}[provider] || 'A');
function Overlay({children,onClose}) {
  return createPortal(<div className="overlay" onMouseDown={onClose}>{children}</div>, document.fullscreenElement || document.body);
}
function App() {
  const claude = useClaudeConnection(), codex = useCodexConnection();
  const board = useTaskBoard();
  const grok = board.state.grok || GROK;
  const qwen = useMemo(()=>withTaskWorkers(localQwenConnection(board.state.runtime),board.state.runtime,'Local Qwen'),[board.state.runtime]);
  const pendingTaskCount = board.state.tasks.filter(task=>task.status==='pending').length;
  const seats = useRef(new Map());
  const roster = useMemo(()=>buildSharedRoster({claude:withTaskWorkers(claude,board.state.runtime,'Claude Code'),codex:withTaskWorkers(codex,board.state.runtime,'Codex'),grok,'local-qwen':qwen,gemini:withTaskWorkers({agents:[]},board.state.runtime,'Gemini')},seats.current),[claude,codex,grok,qwen,board.state.runtime]);
  const residents = useMemo(()=>connectedProviderResidents({claude,codex,grok,runtime:board.state.runtime,roster}),[claude,codex,grok,board.state.runtime,roster]);
  const working = useMemo(()=>workingOfficeAgents(roster),[roster]);
  const activeIndices = useMemo(()=>working.map(agent=>agent.index),[working]);
  const [view,setView] = useState('office');
  const [taskStatusFilter,setTaskStatusFilter] = useState('all');
  const [modal,setModal] = useState(null);
  const [selection,setSelection] = useState(null);
  const [roomDetail,setRoomDetail] = useState(null);
  const [providerDetail,setProviderDetail] = useState(null);
  const [showHint,setShowHint] = useState(()=>!read('office-camera-hint-seen',false));
  const currentAgent = resolveSharedSelection(roster,selection);
  const [assignments,setAssignments] = useState(()=>savedRecords('assignments'));
  const [reports,setReports] = useState(()=>savedRecords('reports'));
  const [form,setForm] = useState({name:'',repo:'',brief:'',agentId:'',status:'Planned'});
  const [reportForm,setReportForm] = useState({title:'',body:'',assignmentId:'',agentId:''});
  const [agentSearch,setAgentSearch] = useState('');
  const [agentFilter,setAgentFilter] = useState('all');
  const [sceneFocus,setSceneFocus] = useState('overview');
  const [cameraMode,setCameraMode] = useState('3d');
  const [resetKey,setResetKey] = useState(0);
  const sceneRef = useRef(null);
  const lang = useLang();
  const date = useMemo(()=>new Intl.DateTimeFormat(uiLocale(),{timeZone:'Asia/Singapore',weekday:'short',day:'numeric',month:'short'}).format(new Date()).toUpperCase(),[lang]);
  const statusCounts = roster.reduce((counts,agent)=>{counts[agent.liveStatus]=(counts[agent.liveStatus] || 0)+1;return counts;},{});
  const filteredAgents = roster.filter(agent=> (agentFilter==='all' || agent.liveStatus===agentFilter) && `${agent.name} ${agent.provider} ${agent.role} ${officeRoleLabel(agent.role,agent.provider,agent.runtimeAgents?.[0])} ${agent.department} ${agent.runtimeAgents?.[0]?.cwd || ''} ${agent.runtimeAgents?.[0]?.id || ''}`.toLowerCase().includes(agentSearch.trim().toLowerCase()));
  const displayAgentName = agent => {const label=officeAgentLabel(agent.name);return label===agent.name?label:t(label);};
  const agentName = id => roster.find(agent=>agent.id===id)?.name || id || 'Studio team';
  const linkedAssignments = currentAgent ? assignments.filter(item=>item.agentId===currentAgent.id) : [];
  const linkedReports = currentAgent ? reports.filter(item=>item.agentId===currentAgent.id) : [];
  const currentTasks = currentAgent ? board.state.tasks.filter(task=>task.status==='running' && taskMatchesAgent(task,currentAgent,board.state.runtime)) : [];
  const active=board.state.runtime?.active;
  const ready = provider => modelReadiness(provider,board.state.runtime,grok);
  const providerResident = residents.find(resident=>resident.provider===providerDetail);
  const providerTaskIds = new Set((board.state.runtime?.running || []).filter(job=>job.provider===providerResident?.key || providerResident?.key==='grok' && job.provider==='grok-bot').map(job=>job.taskId));
  const providerTasks = providerDetail ? board.state.tasks.filter(task=>task.status==='running' && (providerTaskIds.has(task.id) || working.some(agent=>agent.provider===providerDetail && taskMatchesAgent(task,agent,board.state.runtime)))) : [];
  const inspectProvider = provider => {setView('office');setSelection(null);setRoomDetail(null);setModal(null);setProviderDetail(provider);};
  const focusRoom = target => { setSceneFocus(target);setResetKey(key=>key+1); };
  const inspectAgent = agent => {setView('office');setModal(null);setRoomDetail(null);setProviderDetail(null);setSelection(agent);if(agent.liveStatus==='working')focusRoom(`agent-${agent.index}`);};
  const openRoom = target => {setSelection(null);setProviderDetail(null);setModal(null);focusRoom(target);setRoomDetail(target==='overview'?null:target);};
  const openTaskAgent = (task,providerHint) => {
    const provider=({'claude':'Claude Code',codex:'Codex',grok:'Grok',gemini:'Gemini','local-qwen':'Local Qwen'})[providerHint || task.assignee?.provider || task.provider] || providerHint;
    const agent=findTaskAgent(task,roster,board.state.runtime,providerHint);
    if(agent)inspectAgent(agent);else {setSelection(null);setRoomDetail(null);setModal(null);setProviderDetail(provider || 'Studio team');}
  };
  const visitRoom = index => {setView('office');openRoom(officeDepartmentFocus(index));};
  const openDirectory = department => {setSelection(null);setRoomDetail(null);setProviderDetail(null);setAgentSearch(typeof department==='string'?department:'');setAgentFilter('all');setModal('directory');};
  const openAssign = agent => {setSelection(null);setRoomDetail(null);setProviderDetail(null);setForm({name:'',repo:'',brief:'',agentId:agent?.id || '',agentName:agent?.name || '',status:'Planned'});setModal('assign');};
  const openReport = (assignmentId='',agentId='') => {setSelection(null);setRoomDetail(null);setProviderDetail(null);setReportForm({title:'',body:'',assignmentId:typeof assignmentId==='string'?assignmentId:'',agentId});setModal('report');};
  const closeDialogs = ()=>{setModal(null);setSelection(null);setRoomDetail(null);setProviderDetail(null);};
  const navigate = target => {closeDialogs();setTaskStatusFilter(target==='blocked'?'blocked':'all');setView(target==='blocked'?'tasks':target);};
  useEffect(()=>{if(!showHint)return;localStorage.setItem('office-camera-hint-seen','true');const timer=setTimeout(()=>setShowHint(false),6500);return()=>clearTimeout(timer);},[showHint]);
  useEffect(()=>{localStorage.setItem('office-assignments-v2',JSON.stringify(assignments));},[assignments]);
  useEffect(()=>{localStorage.setItem('office-reports-v2',JSON.stringify(reports));},[reports]);
  // Remove camera focus when a worker leaves the floor, while keeping its profile available.
  useEffect(()=>{
    if (sceneFocus.startsWith('agent-') && !working.some(agent=>`agent-${agent.index}`===sceneFocus)) setSceneFocus('overview');
  },[working,sceneFocus]);
  useEffect(()=>{
    if (!modal && !selection && !roomDetail && !providerDetail) return;
    const previous=document.activeElement;
    const dialog=document.querySelector('[role="dialog"]');
    const focusable=()=>[...(dialog?.querySelectorAll('button,input,select,textarea,a[href],summary,[tabindex="0"]') || [])].filter(el=>!el.disabled && el.getClientRects().length>0);
    (dialog?.querySelector('input') || focusable()[0])?.focus();
    const onKey=event=>{
      if(event.key==='Escape')closeDialogs();
      if(event.key==='Tab'){
        const items=focusable(),first=items[0],last=items.at(-1);
        if(event.shiftKey && document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey && document.activeElement===last){event.preventDefault();first?.focus();}
      }
    };
    document.addEventListener('keydown',onKey);
    return ()=>{document.removeEventListener('keydown',onKey);if(previous?.isConnected)previous.focus();};
  },[modal,selection?.id,roomDetail,providerDetail]);
  const saveAssignment = event => {
    event.preventDefault();
    setAssignments(items=>[{...form,floor:3,agentName:form.agentId?(roster.find(agent=>agent.id===form.agentId)?.name || form.agentName || form.agentId):'',id:requestId(),created:new Date().toISOString()},...items]);
    setModal(null);setView('projects');
  };
  const saveReport = event => {
    event.preventDefault();
    setReports(items=>[{...reportForm,floor:3,agentName:reportForm.agentId?agentName(reportForm.agentId):'',id:requestId(),created:new Date().toISOString()},...items]);
    setModal(null);setView('reports');
  };
  const items=view==='projects'?assignments:reports;
  const renderAssignmentRecords = () => <>
          <div className="list-header"><h2>{view==='projects'?'Work in the studio':'Reports & notes'} <span className="list-count">{items.length}</span></h2><span className="saved-label"><Check size={14}/> SAVED LOCALLY</span></div>
          {items.length===0?<div className="empty-state"><div className="empty-icon">{view==='projects'?<FolderGit2 size={28}/>:<FileText size={28}/>}</div><h3>{view==='projects'?'Room for your next project.':'Your reports are ready.'}</h3><p>{view==='projects'?'Add a project and choose an agent or the whole team.':'Save a report or note for the shared team.'}</p><button className="outline-button" onClick={()=>view==='projects'?openAssign():openReport()}><Plus size={15}/>{view==='projects'?'Create assignment':'Add a report'}</button></div>:<div className="items-list">{items.map(item=><article className="item-card" key={item.id}><div className="item-icon" style={{'--accent':'#b7dfc9'}}>{view==='projects'?<FolderGit2 size={19}/>:<FileText size={19}/>}</div><div className="item-main"><div className="item-title"><h3 data-no-i18n>{item.name || item.title}</h3><span className="item-pill">Studio</span></div><p data-no-i18n>{view==='projects'?(item.brief || ''):item.body}</p>{item.repo && <a data-no-i18n href={/^https?:\/\//i.test(item.repo)?item.repo:undefined} target="_blank" rel="noreferrer">{item.repo} <ArrowUpRight size={13}/></a>}{view==='projects'?<div className="item-details"><span>{item.agentId ? `Assigned to ${item.agentName || agentName(item.agentId)}`:'Assigned to the studio team'}</span><label>Manual progress <select value={item.status || 'Planned'} onChange={event=>setAssignments(all=>all.map(record=>record.id===item.id?{...record,status:event.target.value}:record))}>{STATUSES.map(status=><option key={status}>{status}</option>)}</select></label><button onClick={()=>openReport(item.id,item.agentId || '')}>Add report <ArrowRight size={13}/></button></div>:<div className="report-project">{item.assignmentId && <>PROJECT · <span data-no-i18n>{assignments.find(project=>project.id===item.assignmentId)?.name || ''}</span><br/></>}{item.agentId?<><span>AGENT</span> · <span data-no-i18n>{item.agentName || agentName(item.agentId)}</span></>:'STUDIO REPORT'}</div>}<small>ADDED {new Date(item.created).toLocaleDateString('en-SG',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Singapore'}).toUpperCase()} · MANUALLY TRACKED</small></div><button className="delete-button" onClick={()=>{if(window.confirm('Remove this item?'))view==='projects'?setAssignments(all=>all.filter(record=>record.id!==item.id)):setReports(all=>all.filter(record=>record.id!==item.id));}}>Remove</button></article>)}</div>}
          <div className="list-note">Assignments and reports are saved in this browser. Adding one does not start an agent.</div>
  </>;
  return <div className="app-shell shared-office">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span/><span/><span/></div><div><strong>the studio<span className="brand-dot">.</span></strong><small>SINGAPORE HQ</small></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="main-nav" aria-label="Main navigation">
        <button aria-current={view==='office'?'page':undefined} className={view==='office'?'active':''} onClick={()=>navigate('office')}><LayoutDashboard size={17}/> Studio</button>
        <button aria-current={view==='tasks'?'page':undefined} className={view==='tasks'?'active':''} onClick={()=>navigate('tasks')}><ClipboardList size={17}/> Tasks <span className="nav-count">{pendingTaskCount}</span></button>
        <button aria-current={view==='management'?'page':undefined} className={view==='management'?'active':''} onClick={()=>navigate('management')}><UsersRound size={17}/> Dispatch</button>
        <button aria-current={view==='projects'?'page':undefined} className={view==='projects'?'active':''} onClick={()=>navigate('projects')}><BriefcaseBusiness size={17}/> Projects <span className="nav-count">{taskProjects(board.state.tasks).filter(project=>project.path).length}</span></button>
        <button aria-current={view==='reports'?'page':undefined} className={view==='reports'?'active':''} onClick={()=>navigate('reports')}><ClipboardList size={17}/> Reports <span className="nav-count">{reports.length}</span></button>
      </nav>
      <div className="side-divider"/>
      <div className="workspace-label">Studio</div>
      <nav className="shared-room-nav" aria-label="Studio rooms">{SHARED_DEPARTMENTS.map((name,index)=><button key={name} onClick={()=>visitRoom(index)}><i style={{background:PROVIDER_COLORS[['Claude Code','Codex','Grok','Gemini','Local Qwen'][index]]}}/><span>{name}</span><ChevronRight size={13}/></button>)}</nav>
      <div className="sidebar-bottom"><div className="workspace-card"><Box size={17}/><div><strong>One shared workplace</strong><small>Claude · Codex · Grok · Gemini · Qwen</small></div></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="header-context"><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14}/><strong>{({office:'Studio',tasks:'Tasks',management:'Dispatch',projects:'Projects',reports:'Reports'})[view]}</strong></div><span className="header-activity" role="status">{active?.label || `Working now: ${working.length} agents`}</span></div><div className="top-actions"><QuotaIndicator onOpen={()=>{closeDialogs();setModal('usage');}}/><button type="button" className="lang-toggle" data-no-i18n aria-label={lang==='zh'?'Switch to English':'切换到中文'} onClick={()=>setLang(lang==='zh'?'en':'zh')}>{lang==='zh'?'EN':'中'}</button><span className="environment-date"><span>Local</span> · {date}</span></div></header>
      <div className="content">
        {view==='office'?<>
          <div className="office-page-actions"><button className="outline-button" onClick={()=>navigate('tasks')}><Plus size={15}/> Add a request</button></div>
          <section className="office-panel">
            <div className="office-explorer" ref={sceneRef}>
              <AgentStatusPanel agents={roster} loading={claude.loading && codex.loading} onSelectAgent={inspectAgent} provider="Shared studio" floor={3}/>
              <OfficeToolbar agents={roster} departments={SHARED_DEPARTMENTS} focus={sceneFocus} onFocus={openRoom} onReset={()=>{setCameraMode('3d');focusRoom('overview');}} onFullscreen={()=>sceneRef.current?.requestFullscreen?.()} mode={cameraMode} onMode={mode=>{setCameraMode(mode);setResetKey(key=>key+1);}} onDirectory={()=>openDirectory()}/>
              <QwenWatchNotice watch={board.state.qwenWatch} huddle={board.state.huddle} tasks={board.state.tasks} onTasks={()=>navigate('blocked')}/><div className="scene-wrap">{showHint&&<div className="scene-hint">{cameraMode==='plan'?'PINCH OR SCROLL TO ZOOM':'DRAG TO ROTATE · PINCH TO ZOOM'}</div>}<OfficeScene floor={3} agents={roster} residents={residents} onSelectProvider={inspectProvider} board={board.state} activeAgentIndices={activeIndices} focus={sceneFocus} onFocus={openRoom} cameraMode={cameraMode} cameraRevision={resetKey} onSelectAgent={inspectAgent} onDeselect={()=>setSelection(null)} pendingTaskCount={pendingTaskCount} onSelectArea={navigate}/>{working.length===0 && !residents.some(resident=>resident.status==='working') && <div className="shared-empty-floor">{claude.loading && codex.loading?'Checking live activity…':residents.length?'Connected providers remain here while idle. Click a representative for details.':'The studio is quiet. Working agents will appear automatically.'}</div>}</div>

            </div>
          </section>
          <TaskBoardSummary board={board} onOpen={()=>navigate('tasks')} onManagement={()=>setView('management')}/>
          <div className="shared-overview"><SharedConnections claude={claude} codex={codex} grok={grok} qwen={qwen} onDirectory={()=>openDirectory()}/><section className="shared-roles"><span className="section-kicker">CODEX · Specialist Roles</span><h3>Keeping the team moving</h3><div>{['Facilitator','Admin','Helper','Tester'].map(role=><button key={role} onClick={()=>openDirectory(officeRoleLabel(role,'Codex'))}><span>{officeRoleLabel(role,'Codex')}</span><strong>{working.filter(agent=>agent.provider==='Codex' && (agent.role || codexOfficeRole(agent.runtimeAgents[0]))===role).length}</strong></button>)}</div><p>Facilitators host; coordinators organise; builders develop; testers check.</p></section></div>
          <div className="shared-room-cards">{SHARED_DEPARTMENTS.map((department,index)=><button key={department} onClick={()=>visitRoom(index)}><span className="section-kicker">{index===0?'MAIN STUDIO':index===1?'REVIEW & BALANCE':index===2?'DISPATCH':index===4?'LOCAL ASSISTANCE':'RESEARCH'}</span><strong>{department}</strong><p>{ROOM_DESCRIPTIONS[index]}</p><span className="shared-room-visit">{working.filter(agent=>agent.department===department).length} working <ArrowUpRight size={14}/></span></button>)}</div>
        </>:view==='tasks'||view==='management'?<TaskBoard key={`${view}:${taskStatusFilter}`} board={board} initialStatus={taskStatusFilter} initialTab={view==='management'?'management':'board'} onOpenAgent={openTaskAgent}/>:<section className="list-page">
          <div className="page-heading"><div><div className="eyebrow">Studio</div><h1>{view==='projects'?'Projects':'Reports'}<span className="heading-period">.</span></h1><p>{view==='projects'?'Choose a project to see its requests.':'Reports and notes, together in one place.'}</p></div><button className="primary-button" onClick={()=>view==='projects'?openAssign():openReport()}><Plus size={16}/>{view==='projects'?'Assign a project':'Add a report'}</button></div>
          {view==='reports' && <WorkReports/>}
          {view==='projects' && <TaskProjects board={board} onOpenAgent={openTaskAgent}/>}
          {view==='projects' ? <details className="tb-manual-assignments"><summary>Manual assignments</summary>{renderAssignmentRecords()}</details> : renderAssignmentRecords()}
        </section>}
      </div><footer><span>THE STUDIO · SINGAPORE</span><span>Studio</span></footer>
    </main>
    {(currentAgent || roomDetail || providerDetail) && <Overlay onClose={closeDialogs}><div className="dialog detail-drawer" role="dialog" aria-modal="true" aria-label={currentAgent?'Agent details':providerDetail?'Provider details':'Room details'} onMouseDown={event=>event.stopPropagation()}><button className="close-button" onClick={closeDialogs} aria-label="Close"><X size={18}/></button>
      {currentAgent ? <>
        <span className="section-kicker">Agent details</span><div className="agent-heading"><div className="floor-symbol large" style={{'--accent':PROVIDER_COLORS[currentAgent.provider]}}>{providerLetter(currentAgent.provider)}</div><div><h2 data-no-i18n>{displayAgentName(currentAgent)}</h2><p>{officeRoleLabel(currentAgent.role,currentAgent.provider,currentAgent.runtimeAgents?.[0])} · {currentAgent.department}</p></div></div>
        <section className="drawer-section"><h3>Status</h3><div className={`agent-status is-${claudeAgentStatus(currentAgent).id}`}><span aria-hidden="true">{currentAgent.liveStatus==='working'?'▶':currentAgent.liveStatus==='waiting'?'Ⅱ':'○'} </span>{claudeAgentStatus(currentAgent).label}</div><AgentQuota provider={currentAgent.provider} ready={ready(currentAgent.provider)} onOpen={()=>{closeDialogs();setModal('usage');}}/></section>
        <section className="drawer-section"><h3>Current task</h3>{currentTasks.length ? currentTasks.map(task=><p key={task.id} data-no-i18n>{task.title}</p>) : <p>{currentAgent.liveStatus==='working'?'Working in the shared studio.':'No task running.'}</p>}<AgentActivity agent={currentAgent} provider={currentAgent.provider}/><p>{officeRoleDescription(currentAgent)}</p>{linkedAssignments.map(item=><p data-no-i18n key={item.id}>{item.name}</p>)}</section>
        <section className="drawer-section"><h3>Permissions</h3><span className="permission-badge">{['Gemini','Local Qwen'].includes(currentAgent.provider)?'Read-only':'Assigned project only'}</span></section>
        <section className="drawer-section"><h3>Reports</h3>{linkedReports.length?linkedReports.map(item=><p data-no-i18n key={item.id}>{item.title}</p>):<p>No linked reports.</p>}</section>
        <button className="primary-button drawer-primary" onClick={()=>{if(currentAgent.liveStatus==='working'){focusRoom(`agent-${currentAgent.index}`);closeDialogs();}else{closeDialogs();setView('tasks');}}}>{currentAgent.liveStatus==='working'?'Locate in studio':'Open task board'}<ArrowRight size={15}/></button>
      </> : providerDetail ? <><span className="section-kicker">Provider details</span><h2>{providerDetail}</h2><section className="drawer-section"><h3>Status</h3><p>{providerResident ? 'Connected' : ready(providerDetail) === false ? 'Not connected' : 'Readiness unavailable'}</p>{providerResident && <div className={`agent-status is-${providerResident.status}`}><span aria-hidden="true">{providerResident.status==='working'?'▶':'○'} </span>{providerResident.status==='working'?'Working':'Idle'}</div>}<AgentQuota provider={providerDetail} ready={ready(providerDetail)} onOpen={()=>{closeDialogs();setModal('usage');}}/></section><section className="drawer-section"><h3>Current task</h3>{providerTasks.length ? providerTasks.map(task=><p key={task.id} data-no-i18n>{task.title}</p>) : <p>{providerResident?.status==='working'?'A live session or task is running.':providerResident?'Connected and standing by.':'No live agent session. Check the provider connection to resume work.'}</p>}</section><section className="drawer-section"><h3>Permissions</h3><span className="permission-badge">{['Gemini','Local Qwen'].includes(providerDetail)?'Read-only':'Assigned project only'}</span></section><section className="drawer-section"><h3>Reports</h3><p>{reports.length} saved reports</p></section><button className="primary-button drawer-primary" onClick={()=>openDirectory(providerDetail)}>Find agent<UsersRound size={15}/></button></> : <RoomDetails agents={roster} focus={roomDetail} departments={SHARED_DEPARTMENTS} assignmentCount={assignments.length} reportCount={reports.length} pendingTaskCount={pendingTaskCount} onTasks={()=>navigate('tasks')} onManagement={()=>navigate('management')} onDirectory={openDirectory} onReports={()=>navigate('reports')} quota={roomProvider(roomDetail)&&<AgentQuota provider={roomProvider(roomDetail)} ready={ready(roomProvider(roomDetail))} onOpen={()=>{closeDialogs();setModal('usage');}}/>}/>}
    </div></Overlay>}
    {modal==='usage' && <Overlay onClose={closeDialogs}><div className="dialog usage-dialog" role="dialog" aria-modal="true" aria-label="Model usage" onMouseDown={event=>event.stopPropagation()}><button className="close-button" onClick={closeDialogs} aria-label="Close"><X size={18}/></button><span className="section-kicker">ALL MODELS</span><h2>Remaining quota.</h2><UsagePanel/></div></Overlay>}
    {modal==='directory' && <Overlay onClose={closeDialogs}><div className="dialog directory-dialog" role="dialog" aria-modal="true" aria-label="Agent directory" onMouseDown={event=>event.stopPropagation()}><button className="close-button" onClick={closeDialogs} aria-label="Close"><X size={18}/></button><span className="section-kicker">Studio</span><h2>Agent directory.</h2><p className="dialog-copy">Connected provider representatives stay in the studio. This directory lists live agent sessions.</p><label className="directory-search">Search by agent, provider, role or project<input value={agentSearch} onChange={event=>setAgentSearch(event.target.value)} placeholder="e.g. Codex, Tester or Claude"/></label><div className="directory-filters" aria-label="Filter agents by status">{[['all','Everyone'],['working','Running'],['idle','Idle'],['waiting','Waiting'],...(statusCounts.offline?[['offline','Offline']]:[])].map(([id,label])=><button key={id} aria-pressed={agentFilter===id} onClick={()=>setAgentFilter(id)}>{label} · {id==='all'?roster.length:statusCounts[id] || 0}</button>)}</div><span className="directory-count" aria-live="polite">{filteredAgents.length} AGENTS</span><div className="directory-list">{filteredAgents.length?filteredAgents.map(agent=><button key={agent.id} onClick={()=>inspectAgent(agent)}><span className="directory-avatar" style={{'--accent':PROVIDER_COLORS[agent.provider]}}>{providerLetter(agent.provider)}</span><span><strong data-no-i18n>{displayAgentName(agent)}</strong><small>{agent.provider} · {officeRoleLabel(agent.role,agent.provider,agent.runtimeAgents?.[0])}</small></span><span className={`directory-badge is-${claudeAgentStatus(agent).id}`}>{claudeAgentStatus(agent).label}</span><ChevronRight size={15}/></button>):<div className="directory-empty">No agents match this search.</div>}</div></div></Overlay>}
    {(modal==='assign' || modal==='report') && <Overlay onClose={closeDialogs}><div className="dialog" role="dialog" aria-modal="true" aria-label={modal==='assign'?'New assignment':'New report'} onMouseDown={event=>event.stopPropagation()}><button className="close-button" onClick={closeDialogs} aria-label="Close"><X size={18}/></button><span className="section-kicker">Studio / {modal==='assign'?'NEW ASSIGNMENT':'REPORTS'}</span><h2>{modal==='assign'?'Assign a project.':'Add a report.'}</h2>{modal==='assign'?<form onSubmit={saveAssignment}><label>Project name<input required value={form.name} onChange={event=>setForm({...form,name:event.target.value})} placeholder="e.g. Customer dashboard"/></label><label>GitHub repository or project path<input value={form.repo} onChange={event=>setForm({...form,repo:event.target.value})} placeholder="Optional"/></label><label>What needs to be done?<textarea value={form.brief} onChange={event=>setForm({...form,brief:event.target.value})} rows={3}/></label><label>Assign to<select value={form.agentId} onChange={event=>setForm({...form,agentId:event.target.value,agentName:agentName(event.target.value)})}><option value="">Shared studio team</option>{form.agentId && !roster.some(agent=>agent.id===form.agentId) && <option data-no-i18n value={form.agentId}>{form.agentName || form.agentId}</option>}{roster.map(agent=><option data-no-i18n value={agent.id} key={agent.id}>{displayAgentName(agent)} · {agent.provider}</option>)}</select></label><label>Manual progress<select value={form.status} onChange={event=>setForm({...form,status:event.target.value})}>{STATUSES.map(status=><option key={status}>{status}</option>)}</select></label><div className="form-note">Saved locally. This assignment does not start an agent.</div><div className="dialog-actions"><button type="button" className="outline-button" onClick={closeDialogs}>Cancel</button><button className="primary-button">Save assignment <ArrowRight size={15}/></button></div></form>:<form onSubmit={saveReport}><label>Report title<input required value={reportForm.title} onChange={event=>setReportForm({...reportForm,title:event.target.value})}/></label><label>Report<textarea required value={reportForm.body} onChange={event=>setReportForm({...reportForm,body:event.target.value})} rows={5}/></label><label>Related project<select value={reportForm.assignmentId} onChange={event=>setReportForm({...reportForm,assignmentId:event.target.value})}><option value="">No project linked</option>{assignments.map(item=><option data-no-i18n key={item.id} value={item.id}>{item.name}</option>)}</select></label><label>Related agent<select value={reportForm.agentId} onChange={event=>setReportForm({...reportForm,agentId:event.target.value})}><option value="">Studio report</option>{reportForm.agentId && !roster.some(agent=>agent.id===reportForm.agentId) && <option value={reportForm.agentId}>{agentName(reportForm.agentId)}</option>}{roster.map(agent=><option data-no-i18n key={agent.id} value={agent.id}>{displayAgentName(agent)} · {agent.provider}</option>)}</select></label><div className="form-note">Saved locally as a manual note.</div><div className="dialog-actions"><button type="button" className="outline-button" onClick={closeDialogs}>Cancel</button><button className="primary-button">Save report <ArrowRight size={15}/></button></div></form>}</div></Overlay>}
  </div>;
}
createRoot(document.getElementById('root')).render(<App/>);
installDomTranslator(document.body);
