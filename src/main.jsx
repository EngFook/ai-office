import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { createPortal } from 'react-dom';
import { ArrowDownLeft, ArrowRight, ArrowUpRight, Box, BriefcaseBusiness, Check, ChevronDown, ChevronRight, CircleHelp, ClipboardList, Command, Eye, EyeOff, FileText, FolderGit2, Layers3, LayoutDashboard, Loader2, MapPin, Maximize2, MessageSquare, MoreHorizontal, Pencil, Play, Plus, Radio, RotateCcw, Send, Settings2, Sparkles, UsersRound, X } from 'lucide-react';
import { DEFAULT_FLOORS, LAYOUTS, PROVIDERS, normalizeFloor } from './floor-config';
import OfficeScene from './OfficeScene';
import BuildingStack from './BuildingStack';
import { OfficeToolbar, RoomDetails } from './OfficeNavigation';
import './style.css';

const DEPARTMENT_DESCRIPTIONS = {
  Engineering:'Builds and implements software features.', Product:'Shapes requirements and prioritises product work.', Quality:'Plans checks and reviews software quality.', Operations:'Organises delivery and operational work.',
  Research:'Investigates questions and gathers evidence.', Architecture:'Explores systems and technical approaches.', 'Code Review':'Reviews code and identifies potential improvements.', Documentation:'Organises knowledge and writes documentation.',
  Strategy:'Frames goals and long-term direction.', Insights:'Finds patterns and interprets information.', Creative:'Develops concepts and creative directions.', Innovation:'Explores new possibilities and experiments.'
};
const STATUSES = ['Planned','In progress','Blocked','Done'];
const EXAMPLES = ["Research the market for a small online bakery and give me a 4-week launch plan.", "Review the code in ~/Projects/my-app and list the top 5 improvements.", "Plan a December promotion for my shop and draft the announcement."];
const pad = n => String(n).padStart(2, '0');
const isConnected = f => !!f && f.provider.type !== 'none' && (f.provider.hasKey || /localhost|127\.0\.0\.1/.test(f.provider.baseUrl || ''));
const providerLabel = f => isConnected(f) ? `${PROVIDERS[f.provider.type].label.split(' (')[0]} · ${f.provider.model}` : 'Not connected';
const api = async (url, options = {}) => {
  const res = await fetch(url, {...options, headers:{'content-type':'application/json', ...options.headers}});
  const data = await res.json().catch(()=>({}));
  if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`);
  return data;
};
const emptyFloorForm = () => ({id:null, name:'', short:'', letter:'', color:'#7fb8e8', layout:1, hidden:false, department:'', label:'', description:'', departments:['','','',''], provider:{type:'gemini', model:PROVIDERS.gemini.defaultModel, baseUrl:'', systemPrompt:'', apiKey:'', clearKey:false, hasKey:false, keyHint:''}});
const read = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
function Overlay({ children, onClose }) {
  return createPortal(<div className="overlay" onMouseDown={onClose}>{children}</div>, document.fullscreenElement || document.body);
}
function App() {
  const [floorList, setFloorList] = useState(() => DEFAULT_FLOORS.map(f => normalizeFloor(f, f.id)));
  const [apiStatus, setApiStatus] = useState('loading');
  const [floorForm, setFloorForm] = useState(emptyFloorForm);
  const [floorFormError, setFloorFormError] = useState('');
  const [floorTests, setFloorTests] = useState({});
  const [running, setRunning] = useState({});
  const [ceoChat, setCeoChat] = useState(() => read('office-ceo-chat-v1', []));
  const [ceoFloor, setCeoFloor] = useState(() => read('office-ceo-floor', null));
  const [ceoInput, setCeoInput] = useState('');
  const [ceoBusy, setCeoBusy] = useState(false);
  const chatEnd = useRef(null);
  const FLOORS = useMemo(() => Object.fromEntries(floorList.map(f => [f.id, f])), [floorList]);
  const visibleIds = useMemo(() => floorList.filter(f => !f.hidden).map(f => f.id).sort((a,b)=>a-b), [floorList]);
  const floorOf = n => FLOORS[n] || normalizeFloor({name:`Floor ${n}`}, Number(n));
  const agentFor = (floor, index) => ({id:`floor-${floor}-agent-${String(index + 1).padStart(3, '0')}`, index, name:`${floorOf(floor).name} ${String(index + 1).padStart(3, '0')}`, department:floorOf(floor).departments[Math.floor(index / 50)], floor});
  const agentNameForId = id => { const match = /^floor-(\d+)-agent-(\d+)$/.exec(id || ''); return match ? agentFor(Number(match[1]), Number(match[2])-1).name : id; };
  const [floor, setFloor] = useState(1);
  const [view, setView] = useState('office');
  const [modal, setModal] = useState(null);
  const [selectedAgent, setSelectedAgent] = useState(false);
  const [assignments, setAssignments] = useState(() => read('office-assignments-v1', []));
  const [reports, setReports] = useState(() => read('office-reports-v1', []));
  const [form, setForm] = useState({name:'', repo:'', brief:'', floor:1, agentIndex:'', status:'Planned', runNow:true});
  const [reportForm, setReportForm] = useState({title:'', body:'', floor:1, assignmentId:'', agentId:''});
  const [listFloor, setListFloor] = useState('all');
  const [resetKey, setResetKey] = useState(0);
  const [agentSearch, setAgentSearch] = useState('');
  const [agentFilter, setAgentFilter] = useState('all');
  const [sceneFocus, setSceneFocus] = useState('overview');
  const [cameraMode, setCameraMode] = useState('3d');
  const sceneRef = useRef(null);
  const current = floorOf(floor);
  const loadFloors = () => api('/api/floors').then(list => { setFloorList(list); setApiStatus('ok'); }).catch(() => setApiStatus('offline'));
  useEffect(() => { loadFloors(); }, []);
  useEffect(() => { if (visibleIds.length && !visibleIds.includes(floor)) setFloor(visibleIds[0]); }, [visibleIds, floor]);
  const floorAssignments = assignments.filter(a => Number(a.floor) === floor);
  const floorReports = reports.filter(r => Number(r.floor) === floor);
  const activeAgentIndices = useMemo(() => {
    const indices = new Set();
    assignments.forEach(item => {
      if (Number(item.floor) !== floor || item.status !== 'In progress') return;
      const match = typeof item.agentId === 'string' && item.agentId ? /^floor-(\d+)-agent-(\d+)$/.exec(item.agentId) : null;
      const index = match && Number(match[1]) === floor ? Number(match[2]) - 1 : (!item.agentId && item.agentIndex !== '' && item.agentIndex != null ? Number(item.agentIndex) : NaN);
      if (Number.isInteger(index) && index >= 0 && index < 200) indices.add(index);
    });
    return [...indices];
  }, [assignments, floor]);
  const shownItems = (view==='projects' ? assignments : reports).filter(item => listFloor === 'all' || Number(item.floor) === Number(listFloor));
  const agentAssignments = selectedAgent ? assignments.filter(a => a.agentId === selectedAgent.id || (a.agentId == null && a.agentIndex !== '' && a.agentIndex != null && Number(a.floor) === floor && Number(a.agentIndex) === selectedAgent.index)) : [];
  const agentReports = selectedAgent ? reports.filter(r => r.agentId === selectedAgent.id) : [];
  useEffect(() => { localStorage.setItem('office-assignments-v1', JSON.stringify(assignments)); }, [assignments]);
  useEffect(() => { localStorage.setItem('office-reports-v1', JSON.stringify(reports)); }, [reports]);
  useEffect(() => { localStorage.setItem('office-ceo-chat-v1', JSON.stringify(ceoChat)); }, [ceoChat]);
  useEffect(() => { localStorage.setItem('office-ceo-floor', JSON.stringify(ceoFloor)); }, [ceoFloor]);
  useEffect(() => { if (view==='ceo') chatEnd.current?.scrollIntoView({block:'end'}); }, [view, ceoChat.length, ceoBusy]);
  useEffect(() => {
    if (!modal && !selectedAgent) return;
    const previous = document.activeElement;
    const dialog = document.querySelector('[role="dialog"]');
    const focusable = () => [...(dialog?.querySelectorAll('button, input, select, textarea, a[href]') || [])].filter(el=>!el.disabled);
    const firstInput = dialog?.querySelector('input');
    (firstInput || focusable()[0])?.focus();
    const onKey = e => {
      if (e.key==='Escape') { setModal(null); setSelectedAgent(false); }
      if (e.key==='Tab') {
        const items=focusable(), first=items[0], last=items[items.length-1];
        if (e.shiftKey && document.activeElement===first) { e.preventDefault(); last?.focus(); }
        else if (!e.shiftKey && document.activeElement===last) { e.preventDefault(); first?.focus(); }
      }
    };
    document.addEventListener('keydown',onKey);
    return ()=>{document.removeEventListener('keydown',onKey); if(previous?.isConnected) previous.focus();};
  }, [modal, selectedAgent?.id]);
  const date = useMemo(() => new Intl.DateTimeFormat('en-SG', {timeZone:'Asia/Singapore', weekday:'short', day:'numeric', month:'short'}).format(new Date()).toUpperCase(), []);
  const goFloor = n => { setFloor(n); setView('office'); setSelectedAgent(false); setSceneFocus('overview'); setResetKey(k=>k+1); };
  const focusRoom = target => { setSceneFocus(target); setResetKey(k=>k+1); };
  const locateAgent = agent => { setFloor(agent.floor); setView('office'); setSelectedAgent(false); setModal(null); focusRoom(`agent-${agent.index}`); requestAnimationFrame(()=>sceneRef.current?.scrollIntoView({behavior:'smooth',block:'center'})); };
  const visitDepartment = index => { focusRoom(`department-${index}`); sceneRef.current?.scrollIntoView({behavior:'smooth',block:'center'}); };
  const directoryAgents = Array.from({length:200},(_,i)=>agentFor(floor,i)).filter(a=>`${a.name} ${a.department}`.toLowerCase().includes(agentSearch.trim().toLowerCase()) && (agentFilter==='all' || (agentFilter==='working' ? activeAgentIndices.includes(a.index) : !activeAgentIndices.includes(a.index))));
  const addAssignment = e => { e.preventDefault(); const {runNow, ...fields} = form; const item = {...fields, agentId: form.agentIndex === '' ? '' : agentFor(Number(form.floor), Number(form.agentIndex)).id, id: crypto.randomUUID(), created: new Date().toISOString()}; setAssignments(items=>[item,...items]); if (runNow && isConnected(floorOf(item.floor))) runAssignment(item); setFloor(Number(form.floor)); setForm({name:'',repo:'',brief:'',floor:Number(form.floor),agentIndex:'',status:'Planned',runNow}); setModal(null); setListFloor(String(form.floor)); setView('projects'); };
  const addReport = e => { e.preventDefault(); const item = {...reportForm,id:crypto.randomUUID(),created:new Date().toISOString()}; setReports([item,...reports]); setFloor(Number(reportForm.floor)); setReportForm({title:'',body:'',floor:Number(reportForm.floor),assignmentId:'',agentId:''}); setModal(null); setListFloor(String(reportForm.floor)); setView('reports'); };
  const openAssign = (agent) => { setForm(f => ({...f, floor, agentIndex: agent && Number.isInteger(agent.index) ? String(agent.index) : ''})); setModal('assign'); };
  const openDirectory = (department) => { setAgentSearch(typeof department === 'string' ? department : ''); setAgentFilter('all'); setModal('directory'); };
  const openReport = (assignmentId, agent) => { setReportForm(f => ({...f, floor, assignmentId: typeof assignmentId === 'string' ? assignmentId : '', agentId: agent?.id || ''})); setModal('report'); };
  const openFloorList = target => { setListFloor(String(floor)); setView(target); };
  const updateStatus = (id, status) => setAssignments(items => items.map(item => item.id === id ? {...item, status} : item));
  // Send an assignment to the floor's LLM. The agent sits at their desk while it runs; the answer is filed as a report.
  const runAssignment = async item => {
    const target = floorOf(item.floor);
    const agent = item.agentIndex !== '' && item.agentIndex != null ? agentFor(Number(item.floor), Number(item.agentIndex)) : null;
    setRunning(r => ({...r, [item.id]: true}));
    setAssignments(items => items.map(x => x.id === item.id ? {...x, status:'In progress', lastError:''} : x));
    try {
      const result = await api('/api/run', {method:'POST', body:JSON.stringify({floorId:target.id, agentName:agent?.name || '', department:agent?.department || '', project:{name:item.name, repo:item.repo, brief:item.brief}})});
      setReports(list => [{id:crypto.randomUUID(), created:new Date().toISOString(), title:`${item.name} — ${agent?.name || target.name + ' team'}`, body:result.text, floor:Number(item.floor), assignmentId:item.id, agentId:item.agentId || '', source:'ai', model:result.model}, ...list]);
      setAssignments(items => items.map(x => x.id === item.id ? {...x, status:'Done', lastRun:new Date().toISOString()} : x));
    } catch (error) {
      setAssignments(items => items.map(x => x.id === item.id ? {...x, status:'Blocked', lastError:error.message} : x));
    } finally {
      setRunning(r => { const next = {...r}; delete next[item.id]; return next; });
    }
  };
  // ---- CEO chat: plans a goal into tasks for the floors, then summarizes the results ----
  const connectedFloors = floorList.filter(f => !f.hidden && isConnected(f));
  const ceoFloorId = connectedFloors.some(f => f.id === ceoFloor) ? ceoFloor : connectedFloors[0]?.id;
  const ceoHistory = list => list.filter(m => !m.error).map(m => ({role:m.role, content: m.role==='ceo' && m.tasks?.length ? `${m.text}\n\nProposed tasks:\n${m.tasks.map(t => `- ${t.title} → ${floorOf(t.floorId).name} / ${t.department}`).join('\n')}${m.status==='approved' ? '\n(The founder approved these and they were started.)' : m.status==='dismissed' ? '\n(The founder dismissed this plan.)' : ''}` : m.text}));
  const askCeo = async e => {
    e?.preventDefault();
    const text = ceoInput.trim();
    if (!text || ceoBusy || !ceoFloorId) return;
    const next = [...ceoChat, {id:crypto.randomUUID(), role:'user', text, created:new Date().toISOString()}];
    setCeoChat(next); setCeoInput(''); setCeoBusy(true);
    try {
      const r = await api('/api/ceo', {method:'POST', body:JSON.stringify({floorId:ceoFloorId, messages:ceoHistory(next)})});
      setCeoChat(list => [...list, {id:crypto.randomUUID(), role:'ceo', text:r.reply || '(No reply.)', tasks:r.tasks, status:r.tasks.length ? 'proposed' : undefined, goal:text, floorId:ceoFloorId, created:new Date().toISOString()}]);
    } catch (error) {
      setCeoChat(list => [...list, {id:crypto.randomUUID(), role:'ceo', text:`I couldn't reply: ${error.message}`, error:true, created:new Date().toISOString()}]);
    } finally { setCeoBusy(false); }
  };
  const updateCeoTask = (msgId, i, patch) => setCeoChat(list => list.map(m => m.id===msgId ? {...m, tasks:m.tasks.map((t,j) => j===i ? {...t, ...patch} : t)} : m));
  const removeCeoTask = (msgId, i) => setCeoChat(list => list.map(m => m.id===msgId ? {...m, tasks:m.tasks.filter((_,j) => j!==i)} : m));
  const approvePlan = msg => {
    // Give each task to a free agent in the chosen department so you can watch them sit down at their desks.
    const busy = new Set(assignments.filter(a => a.status==='In progress' && a.agentId).map(a => a.agentId));
    const created = msg.tasks.map(t => {
      const f = floorOf(t.floorId);
      const dept = Math.max(0, f.departments.findIndex(d => d.toLowerCase() === String(t.department).toLowerCase()));
      let index = dept * 50;
      for (let k = 0; k < 50; k++) { const id = agentFor(f.id, dept*50 + k).id; if (!busy.has(id)) { index = dept*50 + k; busy.add(id); break; } }
      return {id:crypto.randomUUID(), name:t.title, repo:t.repo || '', brief:t.brief, floor:f.id, agentIndex:String(index), agentId:agentFor(f.id, index).id, status:'Planned', goalId:msg.id, created:new Date().toISOString()};
    });
    setAssignments(items => [...created, ...items]);
    setCeoChat(list => list.map(m => m.id===msg.id ? {...m, status:'approved', summary:'waiting', assignmentIds:created.map(c => c.id)} : m));
    created.forEach(item => runAssignment(item));
  };
  const summarizing = useRef(new Set());
  useEffect(() => {
    ceoChat.filter(m => m.status==='approved' && m.summary==='waiting').forEach(m => {
      const items = assignments.filter(a => a.goalId === m.id);
      if (!items.length || summarizing.current.has(m.id) || items.some(a => running[a.id] || !['Done','Blocked'].includes(a.status))) return;
      summarizing.current.add(m.id);
      const done = reports.filter(r => items.some(a => a.id === r.assignmentId)).map(r => ({title:r.title, body:r.body}));
      const failed = items.filter(a => a.status==='Blocked').map(a => ({title:`${a.name} (FAILED)`, body:a.lastError || 'The task failed.'}));
      setCeoChat(list => list.map(x => x.id===m.id ? {...x, summary:'writing'} : x));
      api('/api/ceo', {method:'POST', body:JSON.stringify({mode:'summary', floorId:m.floorId ?? ceoFloorId, goal:m.goal, messages:ceoHistory(ceoChat), reports:[...done, ...failed]})})
        .then(r => {
          setCeoChat(list => [...list.map(x => x.id===m.id ? {...x, summary:'done'} : x), {id:crypto.randomUUID(), role:'ceo', kind:'summary', text:r.reply, created:new Date().toISOString()}]);
          setReports(list => [{id:crypto.randomUUID(), created:new Date().toISOString(), title:`CEO summary — ${m.goal.slice(0,80)}`, body:r.reply, floor:m.floorId ?? ceoFloorId, assignmentId:'', agentId:'', source:'ai', model:'CEO'}, ...list]);
        })
        .catch(error => setCeoChat(list => [...list.map(x => x.id===m.id ? {...x, summary:'failed'} : x), {id:crypto.randomUUID(), role:'ceo', text:`The tasks are finished, but I couldn't write the summary: ${error.message}`, error:true, created:new Date().toISOString()}]))
        .finally(() => summarizing.current.delete(m.id));
    });
  }, [ceoChat, assignments, reports, running]);
  const openFloorEditor = f => { setFloorFormError(''); setFloorForm(f ? {...f, departments:[...f.departments], provider:{...f.provider, apiKey:'', clearKey:false}} : {...emptyFloorForm(), layout:(floorList.length % 3) + 1}); setModal('floor'); };
  const saveFloor = async e => {
    e.preventDefault(); setFloorFormError('');
    const {id, ...body} = floorForm;
    try {
      const saved = await api(id ? `/api/floors/${id}` : '/api/floors', {method:id ? 'PUT' : 'POST', body:JSON.stringify(body)});
      setFloorList(list => id ? list.map(f => f.id === id ? saved : f) : [...list, saved]);
      setFloorTests(t => ({...t, [saved.id]: undefined}));
      setModal(null);
    } catch (error) { setFloorFormError(error.message); }
  };
  const toggleHidden = async f => {
    try { const saved = await api(`/api/floors/${f.id}`, {method:'PUT', body:JSON.stringify({hidden:!f.hidden})}); setFloorList(list => list.map(x => x.id === f.id ? saved : x)); }
    catch (error) { window.alert(error.message); }
  };
  const testFloor = async f => {
    setFloorTests(t => ({...t, [f.id]: {state:'testing'}}));
    try { const r = await api(`/api/floors/${f.id}/test`, {method:'POST'}); setFloorTests(t => ({...t, [f.id]: {state:'ok', message:`Connected — model replied “${r.reply}”`}})); }
    catch (error) { setFloorTests(t => ({...t, [f.id]: {state:'error', message:error.message}})); }
  };
  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><span></span><span></span><span></span></div><div><strong>the ai office<span className="brand-dot">.</span></strong><small>SINGAPORE HQ</small></div></div>
      <div className="workspace-label">WORKSPACE</div>
      <nav className="main-nav" aria-label="Main navigation">
        <button className={view==='ceo'?'active':''} onClick={()=>setView('ceo')}><MessageSquare size={17}/> Talk to the CEO {ceoBusy && <Loader2 size={13} className="spin nav-count"/>}</button>
        <button className={view==='office'?'active':''} onClick={()=>setView('office')}><LayoutDashboard size={17}/> Office overview <span className="nav-indicator"/></button>
        <button className={view==='projects'?'active':''} onClick={()=>{setListFloor('all');setView('projects')}}><BriefcaseBusiness size={17}/> Projects <span className="nav-count">{assignments.length}</span></button>
        <button className={view==='reports'?'active':''} onClick={()=>{setListFloor('all');setView('reports')}}><ClipboardList size={17}/> File holder <span className="nav-count">{reports.length}</span></button>
        <button className={view==='floors'?'active':''} onClick={()=>setView('floors')}><Settings2 size={17}/> Floors & AI <span className="nav-count">{floorList.filter(isConnected).length}/{floorList.length}</span></button>
      </nav>
      <div className="side-divider"/>
      <div className="workspace-label floors-heading">YOUR FLOORS <span>{pad(visibleIds.length)}</span></div>
      <div className="floor-nav">{[...visibleIds].reverse().map(n=><button key={n} className={floor===n && view==='office'?'floor-active':''} onClick={()=>goFloor(n)}><span className="floor-number">{pad(n)}</span><span className="floor-nav-text"><strong>{FLOORS[n].short}</strong><small>{FLOORS[n].departments[0]}</small></span><i style={{background:FLOORS[n].color}} title={providerLabel(FLOORS[n])}/></button>)}</div>
      <div className="sidebar-bottom"><div className="workspace-card"><div className="workspace-icon"><Box size={17}/></div><div><strong>Your workspace</strong><small>Local to this browser</small></div><ChevronDown size={14}/></div><div className="profile"><div className="profile-avatar">B</div><div><strong>Boss workspace</strong><small>Office administrator</small></div><MoreHorizontal size={17}/></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="breadcrumbs"><span>Workspace</span><ChevronRight size={14}/><strong>{view==='office'?'Office overview':view==='projects'?'Projects':view==='floors'?'Floors & AI':view==='ceo'?'CEO office':'File holder'}</strong></div><div className="top-actions"><span className="local-badge"><span/> LOCAL WORKSPACE</span><span className="top-separator"/><span className="date">{date} &nbsp;·&nbsp; SGT</span><div className="top-avatar">B</div></div></header>
      <div className="content">
        {view==='office' ? <>
          <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> YOUR WORKSPACE <span className="eyebrow-muted">/</span> SINGAPORE</div><h1>Welcome to your office<span className="heading-period">.</span></h1><p>A little more room for big ideas. Here's what's happening today.</p></div><div className="heading-actions"><button className="outline-button" onClick={()=>setView('ceo')}><MessageSquare size={16}/> Talk to the CEO</button><button className="primary-button" onClick={openAssign}><Plus size={16}/> Assign a project</button></div></div>
          <div className="dashboard-grid"><div className="stack-column"><BuildingStack floor={floor} floors={visibleIds.map(n=>FLOORS[n])} onSelectFloor={goFloor}/></div><section className="office-panel"><div className="panel-heading"><div><div className="section-kicker"><span className="live-dot"/> THE OFFICE <span className="section-divider">/</span> INTERACTIVE VIEW</div><h2>{current.identity} <span>↗</span></h2><p>{current.floorStory}</p></div><div className="scene-actions"><button className="icon-button" onClick={openDirectory} aria-label="Open agent directory" title="Open agent directory"><UsersRound size={15}/></button><button className="icon-button" onClick={()=>sceneRef.current?.requestFullscreen?.()} aria-label="Expand office view" title="Expand office view"><Maximize2 size={15}/></button><button className="icon-button" onClick={()=>{setCameraMode('3d');focusRoom('overview')}} aria-label="Reset office view" title="Reset office view"><RotateCcw size={15}/></button></div></div>
            <div className="office-explorer" ref={sceneRef}><OfficeToolbar departments={current.departments} focus={sceneFocus} onFocus={focusRoom} mode={cameraMode} onMode={mode=>{setCameraMode(mode);setResetKey(k=>k+1)}} onDirectory={openDirectory}/><div className="scene-wrap"><div className="scene-top-label"><span>●</span> FLOOR {pad(floor)} <i/> {current.label}</div><div className="scene-hint"><span className="desktop-hint">{cameraMode==='plan' ? 'RIGHT-DRAG TO PAN · SCROLL TO ZOOM' : 'DRAG TO ROTATE · SCROLL TO ZOOM'}</span><span className="touch-hint">DRAG TO ROTATE &nbsp;·&nbsp; PINCH TO ZOOM</span></div><OfficeScene info={current} layout={current.layout} focus={sceneFocus} onFocus={focusRoom} cameraMode={cameraMode} cameraRevision={resetKey} activeAgentIndices={activeAgentIndices} onSelectAgent={agent=>setSelectedAgent(agentFor(floor,agent.index))} onSelectArea={area=>openFloorList(area==='reports'?'reports':'projects')}/><div className="scene-bottom-label"><div className="scene-floor-icon"><Layers3 size={16}/></div><div><small>NOW VIEWING</small><strong>Floor {pad(floor)} <span>—</span> {current.name}</strong></div></div><div className="scene-index">{pad(floor)}<span> / {pad(visibleIds.length)}</span></div></div>
            <div className="scene-legend" aria-label="Visual agent positions"><div><span className="legend-mark legend-active"/> <strong>{activeAgentIndices.length}</strong> at desks <span className="legend-separator">·</span> <span className="legend-mark legend-idle"/> <strong>{200-activeAgentIndices.length}</strong> in idle rooms <span className="legend-separator">·</span> {isConnected(current) ? <><strong>AI</strong> connected</> : <><strong>0</strong> connected</>}</div><small>Agents sit at their desks while their task is In progress — including while the AI is working on it.</small></div>
            <RoomDetails focus={sceneFocus} departments={current.departments} provider={current.name} activeIndices={activeAgentIndices} assignmentCount={floorAssignments.length} reportCount={floorReports.length} onFocus={focusRoom} onDirectory={openDirectory} onProjects={()=>openFloorList('projects')} onReports={()=>openFloorList('reports')} onAgent={index=>setSelectedAgent(agentFor(floor,index))}/></div>
            <div className="floor-selector" style={{gridTemplateColumns:`.8fr repeat(${visibleIds.length},1fr)`}}><div className="selector-intro"><small>EXPLORE</small><strong>Choose a floor</strong></div>{visibleIds.map(n=><button key={n} className={floor===n?'selected':''} onClick={()=>goFloor(n)}><span className="selector-num">{pad(n)}</span><span><strong>{FLOORS[n].name}</strong><small>{LAYOUTS[FLOORS[n].layout].name}</small></span><ArrowUpRight size={14}/></button>)}</div>
          </section>
          <aside className="right-column"><div className="floor-card"><div className="card-top"><span className="section-kicker">CURRENT FLOOR · 200 VIRTUAL AGENTS</span><MoreHorizontal size={18}/></div><div className="floor-card-title"><div className="floor-symbol" style={{'--accent':current.color}}>{current.letter}</div><div><small>FLOOR {pad(floor)}</small><h3>{current.name}</h3></div></div><p>{current.description}</p><div className="floor-identity"><span>THIS FLOOR</span><strong>{current.identity}</strong></div><div className="status-line"><span><i style={isConnected(current)?{background:'#8fc9aa'}:undefined}/> AI provider</span><strong>{providerLabel(current)}</strong></div><button className="text-link" onClick={()=>openFloorEditor(current)}>Configure this floor <Settings2 size={15}/></button><button className="text-link" onClick={openDirectory}>Browse agent directory <ArrowRight size={15}/></button></div>
            <div className="activity-card"><div className="card-top"><div><span className="section-kicker">AT A GLANCE</span><h3>Floor activity</h3></div><span className="activity-icon"><Radio size={16}/></span></div><div className="metric-row"><div><strong>{String(floorAssignments.length).padStart(2,'0')}</strong><small>ASSIGNMENTS</small></div><div><strong>{String(floorReports.length).padStart(2,'0')}</strong><small>REPORTS</small></div></div><div className="activity-note"><span className="note-icon"><Sparkles size={15}/></span><p>{floorAssignments.length ? 'Your assignments are saved and ready to review.' : 'A fresh start. Assign a project to get this floor organised.'}</p></div><button className="outline-button" onClick={openAssign}><Plus size={15}/> New assignment</button></div>
            <div className="connection-note"><span className="connection-dot" style={isConnected(current)?{background:'#8fc9aa'}:undefined}/><div><strong>{isConnected(current) ? `AI connected · ${current.provider.model}` : 'Simulated floor · not connected'}</strong><p>{apiStatus==='offline' ? 'The local API is not running, so floor settings and AI runs are unavailable. Start the app with npm run dev.' : isConnected(current) ? 'Use “Run with AI” on a project to have this floor work on it. Results are filed as reports.' : 'Add an API key in Floors & AI to let this floor work on projects.'}</p></div><CircleHelp size={15}/></div>
          </aside></div>
          <section className="department-section"><div className="department-heading"><div><span className="section-kicker">FLOOR {pad(floor)} / DEPARTMENT DIRECTORY</span><h2>Meet the departments<span className="heading-period">.</span></h2><p>Visit a workspace, find its people, or check who is at a desk.</p></div><button className="outline-button" onClick={openDirectory}><UsersRound size={15}/> All floor agents</button></div><div className="department-grid">{current.departments.map((department,i)=><article className="department-card" key={department}><div className="department-card-top"><span>0{i+1} / ROOM</span><span>50 AGENTS</span></div><h3>{department}</h3><p>{DEPARTMENT_DESCRIPTIONS[department] || `The ${department} team on the ${current.name} floor.`}</p><div className="department-actions"><button className="department-visit" onClick={()=>visitDepartment(i)}>Visit room <MapPin size={13}/></button><button onClick={()=>openDirectory(department)}>View team <ArrowRight size={14}/></button></div></article>)}</div></section>
          <div className="office-shortcuts"><button onClick={()=>openFloorList('projects')}><span className="strip-icon"><BriefcaseBusiness size={17}/></span><span><strong>Project progress</strong><small>{floorAssignments.length} floor assignments · manually tracked</small></span><ArrowRight size={16}/></button><button onClick={()=>openFloorList('reports')}><span className="strip-icon"><FileText size={17}/></span><span><strong>Floor file holder</strong><small>{floorReports.length} saved reports and notes</small></span><ArrowRight size={16}/></button></div>
        </> : view==='ceo' ? <section className="list-page ceo-page">
          <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> YOUR WORKSPACE <span className="eyebrow-muted">/</span> CEO OFFICE</div><h1>Talk to the CEO<span className="heading-period">.</span></h1><p>Describe a goal. The CEO plans it, gives tasks to the right floors once you approve, and reports back with a summary.</p></div>
            <div className="heading-actions"><label className="ceo-floor-picker">CEO runs on<select value={ceoFloorId ?? ''} onChange={e=>setCeoFloor(Number(e.target.value))} disabled={!connectedFloors.length}>{connectedFloors.length ? connectedFloors.map(f=><option key={f.id} value={f.id}>{f.name} · {f.provider.model}</option>) : <option value="">No connected floors</option>}</select></label>{ceoChat.length>0 && <button className="outline-button" onClick={()=>{if(window.confirm('Start a new conversation? Projects and reports are kept.')) setCeoChat([])}}>New conversation</button>}</div></div>
          {!connectedFloors.length && <div className="form-note">Connect at least one floor in Floors & AI to hire a CEO.</div>}
          <div className="ceo-chat">
            {ceoChat.length===0 && <div className="ceo-empty"><span className="section-kicker">TRY A GOAL</span>{EXAMPLES.map(x=><button key={x} onClick={()=>setCeoInput(x)}>{x} <ArrowRight size={13}/></button>)}</div>}
            {ceoChat.map(m=><div key={m.id} className={`ceo-msg ceo-msg--${m.role}${m.error?' is-error':''}`}>
              <small>{m.role==='user' ? 'YOU' : m.kind==='summary' ? 'CEO · SUMMARY' : 'CEO'}</small><p>{m.text}</p>
              {m.tasks?.length>0 && <div className="ceo-plan">
                <span className="section-kicker">PROPOSED PLAN · {m.tasks.length} TASKS</span>
                {m.tasks.map((t,i)=>{ const a = m.assignmentIds && assignments.find(x=>x.id===m.assignmentIds[i]); const f = floorOf(t.floorId); return <div className="ceo-task" key={i} style={{'--accent':f.color}}>
                  <div className="ceo-task-main"><strong>{t.title}</strong><p>{t.brief}</p>{t.repo && <small>{t.repo}</small>}</div>
                  {m.status==='proposed' ? <div className="ceo-task-edit">
                    <select aria-label="Floor" value={t.floorId} onChange={e=>{const nf=floorOf(Number(e.target.value)); updateCeoTask(m.id,i,{floorId:nf.id, department:nf.departments[0]})}}>{connectedFloors.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select>
                    <select aria-label="Department" value={f.departments.find(d=>d.toLowerCase()===String(t.department).toLowerCase()) || f.departments[0]} onChange={e=>updateCeoTask(m.id,i,{department:e.target.value})}>{f.departments.map(d=><option key={d}>{d}</option>)}</select>
                    <button className="delete-button" onClick={()=>removeCeoTask(m.id,i)} aria-label="Remove task"><X size={14}/></button>
                  </div> : <div className="ceo-task-status">{f.short} · {t.department}<br/>{a ? (running[a.id] ? <><Loader2 size={12} className="spin"/> {a.agentId ? agentNameForId(a.agentId) : ''} working…</> : <b className={a.status==='Blocked'?'is-error':''}>{a.status}</b>) : m.status==='dismissed' ? 'Dismissed' : ''}</div>}
                </div>})}
                {m.status==='proposed' && <div className="dialog-actions"><button className="outline-button" onClick={()=>setCeoChat(list=>list.map(x=>x.id===m.id?{...x,status:'dismissed'}:x))}>Dismiss</button><button className="primary-button" onClick={()=>approvePlan(m)}><Play size={15}/> Approve & start {m.tasks.length} tasks</button></div>}
                {m.status==='approved' && <small className="ceo-plan-note">{m.summary==='writing' ? 'All tasks finished · the CEO is writing a summary…' : m.summary==='done' ? 'Done · summary below, full reports in the File holder.' : m.summary==='failed' ? 'Tasks finished · summary failed.' : 'Running · agents sit at their desks while they work. Keep this page open.'}</small>}
              </div>}
            </div>)}
            {ceoBusy && <div className="ceo-msg ceo-msg--ceo"><small>CEO</small><p><Loader2 size={14} className="spin"/> Thinking…</p></div>}
            <div ref={chatEnd}/>
          </div>
          <form className="ceo-input" onSubmit={askCeo}><textarea rows="3" value={ceoInput} onChange={e=>setCeoInput(e.target.value)} onKeyDown={e=>{if(e.key==='Enter' && !e.shiftKey){e.preventDefault();askCeo();}}} placeholder="Describe a goal, or answer the CEO… (Enter to send, Shift+Enter for a new line)" disabled={!connectedFloors.length}/><button className="primary-button" type="submit" disabled={ceoBusy || !ceoInput.trim() || !ceoFloorId}><Send size={15}/> Send</button></form>
          <div className="list-note"><CircleHelp size={16}/><p>The conversation is stored in this browser. Tasks run from this page, so keep it open until they finish. Claude Code CLI floors can work inside local project folders; other floors answer from text only.</p></div>
        </section> : view==='floors' ? <section className="list-page">
          <div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> YOUR WORKSPACE <span className="eyebrow-muted">/</span> FLOORS & AI</div><h1>Floors & AI providers<span className="heading-period">.</span></h1><p>Each floor is a team backed by one LLM. Add floors, connect a provider, or hide floors you don't use.</p></div><button className="primary-button" onClick={()=>openFloorEditor(null)} disabled={apiStatus!=='ok'}><Plus size={16}/> Add a floor</button></div>
          {apiStatus==='offline' && <div className="form-note" style={{marginTop:20}}>The local API isn't reachable, so floor settings can't be changed. Start the app with <code>npm run dev</code> (not a static build).</div>}
          <div className="items-list">{[...floorList].sort((a,b)=>a.id-b.id).map(f=><article className="item-card" key={f.id} style={f.hidden?{opacity:.55}:undefined}><div className="floor-symbol" style={{'--accent':f.color}}>{f.letter}</div><div className="item-main"><div className="item-title"><h3>{f.name}</h3><span className="item-pill">FLOOR {pad(f.id)} · {LAYOUTS[f.layout].name.toUpperCase()}</span>{f.hidden && <span className="item-pill">HIDDEN</span>}<span className="item-pill" style={isConnected(f)?undefined:{color:'#d3b393',background:'#3a332c'}}>{isConnected(f)?'CONNECTED':'NOT CONNECTED'}</span></div><p>{f.description}</p><div className="item-details"><span>{f.provider.type==='none' ? 'No provider' : `${PROVIDERS[f.provider.type].label.split(' (')[0]} · ${f.provider.model}${f.provider.type==='openai' ? ` · ${f.provider.baseUrl}` : ''}${f.provider.type==='claude-cli' ? (f.provider.access==='edit' ? ' · can edit files' : ' · read only') : ''}`} · {f.provider.hasKey ? `key ${f.provider.keyHint}` : 'no API key'}</span><span>{f.departments.join(' · ')}</span></div>{floorTests[f.id] && <small style={{color:floorTests[f.id].state==='error'?'#efad9e':floorTests[f.id].state==='ok'?'#a9dac1':undefined}}>{floorTests[f.id].state==='testing' ? 'TESTING CONNECTION…' : floorTests[f.id].message}</small>}<div className="item-details"><button onClick={()=>openFloorEditor(f)} disabled={apiStatus!=='ok'}><Pencil size={13}/> Edit</button><button onClick={()=>toggleHidden(f)} disabled={apiStatus!=='ok'}>{f.hidden ? <><Eye size={13}/> Show</> : <><EyeOff size={13}/> Hide</>}</button><button onClick={()=>testFloor(f)} disabled={apiStatus!=='ok' || f.provider.type==='none' || floorTests[f.id]?.state==='testing'}><Radio size={13}/> Test connection</button>{!f.hidden && <button onClick={()=>goFloor(f.id)}>Visit floor <ArrowRight size={13}/></button>}</div></div></article>)}</div>
          <div className="list-note"><CircleHelp size={16}/><p>Settings and API keys are saved on the computer running the office (data/floors.json), never in the browser. Keys can also come from environment variables: GEMINI_API_KEY, OPENAI_API_KEY or ANTHROPIC_API_KEY.</p></div>
        </section> : <section className="list-page"><div className="page-heading"><div><div className="eyebrow"><span className="eyebrow-line"/> YOUR WORKSPACE <span className="eyebrow-muted">/</span> {view==='projects'?'PROJECTS':'FILE HOLDER'}</div><h1>{view==='projects'?'Projects':'Your file holder'}<span className="heading-period">.</span></h1><p>{view==='projects'?'A clear view of the work assigned across your office.':'A place to keep notes and reports from each floor.'}</p></div><button className="primary-button" onClick={view==='projects'?openAssign:openReport}><Plus size={16}/>{view==='projects'?' Assign a project':' Add a report'}</button></div>
          <div className="list-header"><div><span className="section-kicker">{view==='projects'?'PROJECT PROGRESS':'FILE HOLDER'}</span><h2>{view==='projects'?'Work in the office':'Reports & notes'} <span className="list-count">{shownItems.length}</span></h2></div><div className="list-tools"><label>Floor <select value={listFloor} onChange={e=>setListFloor(e.target.value)}><option value="all">All floors</option>{floorList.map(f=><option key={f.id} value={f.id}>Floor {pad(f.id)} · {f.short}</option>)}</select></label><span className="saved-label"><Check size={14}/> SAVED LOCALLY</span></div></div>
          {shownItems.length===0?<div className="empty-state"><div className="empty-icon">{view==='projects'?<FolderGit2 size={28}/>:<FileText size={28}/>}</div><h3>{view==='projects'?'Your next big idea belongs here.':'Your file holder is ready.'}</h3><p>{view==='projects'?'Add a project, link its repository, and choose the floor responsible for it.':'Add a report or note, or run a project with AI — its result will be filed here.'}</p><button className="outline-button" onClick={view==='projects'?openAssign:openReport}><Plus size={15}/>{view==='projects'?' Create assignment':' Add a report'}</button></div>:<div className="items-list">{shownItems.map(item=><article className="item-card" key={item.id}><div className="item-icon" style={{'--accent':floorOf(item.floor).color}}>{view==='projects'?<FolderGit2 size={19}/>:<FileText size={19}/>}</div><div className="item-main"><div className="item-title"><h3>{item.name || item.title}</h3><span className="item-pill">FLOOR {pad(item.floor)} · {floorOf(item.floor).short}</span>{item.source==='ai' && <span className="item-pill">AI · {item.model}</span>}</div><p>{view==='projects'?(item.brief || 'No brief added.') : item.body}</p>{item.repo && <a href={/^https?:\/\//i.test(item.repo)?item.repo:undefined} target="_blank" rel="noreferrer">{item.repo} <ArrowUpRight size={13}/></a>}{view==='projects'?<div className="item-details"><span>{item.agentIndex !== '' && item.agentIndex != null ? `Assigned to ${agentFor(Number(item.floor), Number(item.agentIndex)).name}` : 'Assigned to floor · no individual selected'}</span>{isConnected(floorOf(item.floor)) && <button onClick={()=>runAssignment(item)} disabled={!!running[item.id]}>{running[item.id] ? <><Loader2 size={13} className="spin"/> Working…</> : <><Play size={13}/> {item.lastRun ? 'Run again' : 'Run with AI'}</>}</button>}<label>Progress <select value={item.status || 'Planned'} onChange={e=>updateStatus(item.id,e.target.value)} disabled={!!running[item.id]}>{STATUSES.map(status=><option key={status}>{status}</option>)}</select></label><button onClick={()=>{setFloor(Number(item.floor));setReportForm({title:'',body:'',floor:Number(item.floor),assignmentId:item.id,agentId:item.agentId || ''});setModal('report')}}>Add report <ArrowRight size={13}/></button></div>:<div className="report-project">{item.assignmentId && <>PROJECT · {assignments.find(a=>a.id===item.assignmentId)?.name || 'Removed project'}<br/></>}{item.agentId ? `AGENT · ${agentNameForId(item.agentId)}` : 'FLOOR-LEVEL REPORT'}</div>}{item.lastError && <small style={{color:'#efad9e'}}>AI RUN FAILED · {item.lastError}</small>}<small>ADDED {new Date(item.created).toLocaleDateString('en-SG',{day:'numeric',month:'short',year:'numeric',timeZone:'Asia/Singapore'}).toUpperCase()} {view==='projects'?(item.lastRun?' · LAST AI RUN '+new Date(item.lastRun).toLocaleString('en-SG',{timeZone:'Asia/Singapore'}).toUpperCase():''):item.source==='ai'?' · AI REPORT':' · MANUAL REPORT'}</small></div><button className="delete-button" onClick={()=>{if(window.confirm('Remove this item?')) view==='projects'?setAssignments(assignments.filter(x=>x.id!==item.id)):setReports(reports.filter(x=>x.id!==item.id));}}>Remove</button></article>)}</div>}
          <div className="list-note"><CircleHelp size={16}/><p>{view==='projects'?'Projects are stored in this browser. “Run with AI” sends the project name, link and brief to the floor\'s LLM; it cannot open the repository itself.':'Reports come from AI runs or are added by you. They are stored in this browser.'}</p></div>
        </section>}
      </div><footer><span>THE AI OFFICE <b>✳</b> SINGAPORE</span><span>MADE FOR BIG IDEAS &nbsp;·&nbsp; YOUR SPACE TO BUILD</span></footer>
    </main>
    {selectedAgent && <Overlay onClose={()=>setSelectedAgent(false)}><div className="dialog agent-dialog" role="dialog" aria-modal="true" aria-label="Agent details" onMouseDown={e=>e.stopPropagation()}><button className="close-button" onClick={()=>setSelectedAgent(false)} aria-label="Close"><X size={18}/></button><span className="section-kicker">MEET YOUR TEAM <span className="section-divider">/</span> FLOOR {pad(floor)}</span><div className="agent-heading"><div className="floor-symbol large" style={{'--accent':current.color}}>{current.letter}</div><div><h2>{selectedAgent.name || current.name}</h2><p>{selectedAgent.department}{selectedAgent.index != null ? ` · Agent ${String(selectedAgent.index + 1).padStart(3, '0')}` : ''}</p></div></div><div className="agent-status" style={isConnected(current)?{color:'#a9dac1',background:'#203932'}:undefined}><span className="connection-dot" style={isConnected(current)?{background:'#8fc9aa'}:undefined}/> {isConnected(current) ? `POWERED BY ${current.provider.model.toUpperCase()}` : 'NOT CONNECTED'}</div><div className="agent-location"><span className={activeAgentIndices.includes(selectedAgent.index) ? "legend-mark legend-active" : "legend-mark legend-idle"}/><strong>{activeAgentIndices.includes(selectedAgent.index) ? "At desk" : "In idle room"}</strong><span> · based on manually entered individual tasks</span></div><p className="dialog-copy">{DEPARTMENT_DESCRIPTIONS[selectedAgent.department] || current.description} {isConnected(current) ? `Tasks assigned to this person can be run with ${current.provider.model}; they take on this name and department.` : 'This person is a virtual placeholder until this floor has an AI provider.'}</p><button className="locate-agent" onClick={()=>locateAgent(selectedAgent)}><span><MapPin size={15}/> Locate in office</span><ArrowUpRight size={15}/></button><div className="agent-task-heading"><strong>Assigned to this person</strong><span>{agentAssignments.length} TASKS</span></div>{agentAssignments.length ? <div className="agent-task-list">{agentAssignments.map(item=><div key={item.id}><span>{item.name}</span><strong>{item.status || 'Planned'}</strong></div>)}</div> : <div className="agent-empty">No individual assignments yet. Floor-wide assignments are separate.</div>}<div className="agent-task-heading"><strong>Reports linked to this person</strong><span>{agentReports.length} REPORTS</span></div>{agentReports.length ? <div className="agent-task-list">{agentReports.map(item=><div key={item.id}><span>{item.title}</span><strong>{item.source==='ai' ? 'AI REPORT' : 'MANUAL NOTE'}</strong></div>)}</div> : <div className="agent-empty">No individual reports yet.</div>}<div className="agent-facts"><div><small>FLOOR ASSIGNMENTS</small><strong>{String(floorAssignments.length).padStart(2,'0')}</strong></div><div><small>FLOOR REPORTS</small><strong>{String(floorReports.length).padStart(2,'0')}</strong></div></div><div className="dialog-actions agent-actions"><button className="outline-button" onClick={()=>{setSelectedAgent(false);openFloorList('reports')}}>Open file holder</button><button className="outline-button" onClick={()=>{const agent=selectedAgent;setSelectedAgent(false);openReport('',agent)}}>Add report</button><button className="primary-button" onClick={()=>{const agent=selectedAgent;setSelectedAgent(false);openAssign(agent)}}>Assign task <ArrowRight size={15}/></button></div></div></Overlay>}
    {modal==='directory' && <Overlay onClose={()=>setModal(null)}><div className="dialog directory-dialog" role="dialog" aria-modal="true" aria-label="Agent directory" onMouseDown={e=>e.stopPropagation()}><button className="close-button" onClick={()=>setModal(null)} aria-label="Close"><X size={18}/></button><span className="section-kicker">FLOOR {pad(floor)} <span className="section-divider">/</span> VIRTUAL TEAM</span><h2>Agent directory.</h2><p className="dialog-copy">200 virtual team members on this floor. {isConnected(current) ? `Each one answers with ${current.provider.model} when you run their task.` : 'No AI provider is connected to this floor yet.'}</p><label className="directory-search">Search by name, number or department<input value={agentSearch} onChange={e=>setAgentSearch(e.target.value)} placeholder="e.g. 042 or Engineering" /></label><div className="directory-filters" aria-label="Filter agents by location">{[['all','Everyone'],['working','At desks'],['idle','Idle rooms']].map(([id,label])=><button key={id} aria-pressed={agentFilter===id} onClick={()=>setAgentFilter(id)}>{label} · {id==='all'?200:id==='working'?activeAgentIndices.length:200-activeAgentIndices.length}</button>)}</div><span className="directory-count" aria-live="polite">{directoryAgents.length} RESULTS · MANUAL TASK STATUS</span><div className="directory-list">{directoryAgents.length ? directoryAgents.map(agent=><button key={agent.id} onClick={()=>{setModal(null);setSelectedAgent(agent)}}><span className="directory-avatar" style={{'--accent':current.color}}>{String(agent.index+1).padStart(3,'0')}</span><span><strong>{agent.name}</strong><small>{agent.department}</small></span><span className={`directory-badge${activeAgentIndices.includes(agent.index)?' is-working':''}`}>{activeAgentIndices.includes(agent.index)?'At desk':'Idle room'}</span><ChevronRight size={15}/></button>) : <div className="directory-empty">No agents match this search and location.<br/>Try a different name or choose Everyone.</div>}</div></div></Overlay>}
    {modal==='floor' && <Overlay onClose={()=>setModal(null)}><div className="dialog" role="dialog" aria-modal="true" aria-label={floorForm.id?'Edit floor':'Add floor'} onMouseDown={e=>e.stopPropagation()}><button className="close-button" onClick={()=>setModal(null)} aria-label="Close"><X size={18}/></button><span className="section-kicker">FLOORS & AI <span className="section-divider">/</span> {floorForm.id ? `FLOOR ${pad(floorForm.id)}` : 'NEW FLOOR'}</span><h2>{floorForm.id ? `Edit ${floorForm.name}.` : 'Add a floor.'}</h2><p className="dialog-copy">Choose who works on this floor and which model powers them.</p>
      <form onSubmit={saveFloor}>
        <label>Floor name<input required value={floorForm.name} onChange={e=>setFloorForm({...floorForm,name:e.target.value})} placeholder="e.g. Gemini"/></label>
        <div className="form-row"><label>Short name<input value={floorForm.short} onChange={e=>setFloorForm({...floorForm,short:e.target.value})} placeholder="Gemini"/></label><label>Letter<input maxLength={2} value={floorForm.letter} onChange={e=>setFloorForm({...floorForm,letter:e.target.value})} placeholder="G"/></label><label>Colour<input type="color" value={floorForm.color} onChange={e=>setFloorForm({...floorForm,color:e.target.value})}/></label></div>
        <label>Floor plan<select value={floorForm.layout} onChange={e=>setFloorForm({...floorForm,layout:Number(e.target.value),identity:'',floorStory:''})}>{Object.entries(LAYOUTS).map(([id,l])=><option key={id} value={id}>{l.name} — {l.floorStory}</option>)}</select></label>
        <label>Focus <span>OPTIONAL</span><input value={floorForm.department} onChange={e=>setFloorForm({...floorForm,department:e.target.value})} placeholder="e.g. Research & analysis"/></label>
        <label>Description <span>OPTIONAL</span><textarea rows="2" value={floorForm.description} onChange={e=>setFloorForm({...floorForm,description:e.target.value})} placeholder="What this floor is for"/></label>
        <label>Departments (4 rooms × 50 agents)<div className="form-row form-row--4">{floorForm.departments.map((d,i)=><input key={i} required value={d} aria-label={`Department ${i+1}`} onChange={e=>{const departments=[...floorForm.departments];departments[i]=e.target.value;setFloorForm({...floorForm,departments})}} placeholder={`Team ${i+1}`}/>)}</div></label>
        <label>LLM provider<select value={floorForm.provider.type} onChange={e=>{const type=e.target.value;setFloorForm({...floorForm,provider:{...floorForm.provider,type,model:PROVIDERS[type].defaultModel,baseUrl:PROVIDERS[type].defaultBaseUrl||''}})}}>{Object.entries(PROVIDERS).map(([id,p])=><option key={id} value={id}>{p.label}</option>)}</select></label>
        {floorForm.provider.type!=='none' && <>
          <label>Model<input required value={floorForm.provider.model} onChange={e=>setFloorForm({...floorForm,provider:{...floorForm.provider,model:e.target.value}})} placeholder={PROVIDERS[floorForm.provider.type].defaultModel}/></label>
          {PROVIDERS[floorForm.provider.type].needsBaseUrl && <label>Base URL<input required value={floorForm.provider.baseUrl} onChange={e=>setFloorForm({...floorForm,provider:{...floorForm.provider,baseUrl:e.target.value}})} placeholder="https://api.openai.com/v1"/></label>}
          {floorForm.provider.type==='claude-cli' && <label>File access<select value={floorForm.provider.access} onChange={e=>setFloorForm({...floorForm,provider:{...floorForm.provider,access:e.target.value}})}><option value="read">Read only — can read project folders and search the web</option><option value="edit">Can edit files in the project folder</option></select></label>}
          {floorForm.provider.type==='claude-cli' ? <div className="form-note">Uses the Claude Code sign-in on the computer running the office (run <code>claude</code> and <code>/login</code> there). Model can be sonnet, opus or fable. Projects whose path is a local folder under ~/Projects are worked on in that folder; shell commands are never allowed.</div>
          : PROVIDERS[floorForm.provider.type].noKey ? <div className="form-note">{floorForm.provider.hasKey ? 'Signed in with the credentials file from VERTEX_CREDENTIALS in .env.' : 'No API key needed: set VERTEX_CREDENTIALS (and optionally VERTEX_PROJECT, VERTEX_LOCATION) in the .env file next to package.json, then restart the office. See README.'}</div> : <>
          <label>API key <span>{floorForm.provider.hasKey ? `SAVED ${floorForm.provider.keyHint.toUpperCase()} — LEAVE BLANK TO KEEP` : `OR SET ${PROVIDERS[floorForm.provider.type].keyEnv}`}</span><input type="password" autoComplete="off" value={floorForm.provider.apiKey} onChange={e=>setFloorForm({...floorForm,provider:{...floorForm.provider,apiKey:e.target.value,clearKey:false}})} placeholder={floorForm.provider.hasKey ? '••••••••' : 'Paste your API key'}/></label>
          {floorForm.provider.hasKey && floorForm.provider.keyHint.startsWith('…') && <label className="checkbox-row"><input type="checkbox" checked={floorForm.provider.clearKey} onChange={e=>setFloorForm({...floorForm,provider:{...floorForm.provider,clearKey:e.target.checked,apiKey:''}})}/> Remove the saved key</label>}</>}
          <label>Extra instructions <span>OPTIONAL</span><textarea rows="3" value={floorForm.provider.systemPrompt} onChange={e=>setFloorForm({...floorForm,provider:{...floorForm.provider,systemPrompt:e.target.value}})} placeholder="e.g. Always answer in British English and include a risk section."/></label>
        </>}
        <label className="checkbox-row"><input type="checkbox" checked={floorForm.hidden} onChange={e=>setFloorForm({...floorForm,hidden:e.target.checked})}/> Hide this floor from the building</label>
        {floorFormError && <div className="form-note" style={{color:'#efad9e',background:'#3a2a2a'}}>{floorFormError}</div>}
        <div className="dialog-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Cancel</button><button className="primary-button" type="submit">Save floor <ArrowRight size={15}/></button></div>
      </form></div></Overlay>}
    {modal && modal!=='directory' && modal!=='floor' && <Overlay onClose={()=>setModal(null)}><div className="dialog" role="dialog" aria-modal="true" aria-label={modal==='assign'?'New assignment':'New report'} onMouseDown={e=>e.stopPropagation()}><button className="close-button" onClick={()=>setModal(null)} aria-label="Close"><X size={18}/></button><span className="section-kicker">YOUR WORKSPACE <span className="section-divider">/</span> {modal==='assign'?'NEW ASSIGNMENT':'FILE HOLDER'}</span><h2>{modal==='assign'?'Make room for a new idea.':'Add a report.'}</h2><p className="dialog-copy">{modal==='assign'?'Give your project a home and choose the team responsible.':'Save a note or report to a floor for easy reference.'}</p>{modal==='assign'?<form onSubmit={addAssignment}><label>Project name<input required value={form.name} onChange={e=>setForm({...form,name:e.target.value})} placeholder="e.g. Customer dashboard"/></label><label>GitHub repository or project path <span>OPTIONAL</span><input value={form.repo} onChange={e=>setForm({...form,repo:e.target.value})} placeholder="https://github.com/your-team/project"/></label><label>What needs to be done? <span>OPTIONAL</span><textarea value={form.brief} onChange={e=>setForm({...form,brief:e.target.value})} placeholder="Describe the work for your team..." rows="3"/></label><label>Assign to floor<select value={form.floor} onChange={e=>setForm({...form,floor:Number(e.target.value),agentIndex:''})}>{visibleIds.map(n=><option key={n} value={n}>Floor {pad(n)} — {FLOORS[n].name}</option>)}</select></label><label>Individual agent <span>OPTIONAL</span><select value={form.agentIndex} onChange={e=>setForm({...form,agentIndex:e.target.value})}><option value="">Floor-wide assignment</option>{Array.from({length:200},(_,i)=>agentFor(Number(form.floor),i)).map(agent=><option value={agent.index} key={agent.id}>{agent.name} · {agent.department}</option>)}</select></label><label>Manual progress<select value={form.status} onChange={e=>setForm({...form,status:e.target.value})}>{STATUSES.map(status=><option key={status}>{status}</option>)}</select></label>{isConnected(floorOf(form.floor)) ? <label className="checkbox-row"><input type="checkbox" checked={form.runNow} onChange={e=>setForm({...form,runNow:e.target.checked})}/> Start working on it now with {floorOf(form.floor).provider.model}</label> : <div className="form-note">This floor has no AI provider, so the assignment is tracked manually. Connect one in Floors & AI.</div>}<div className="dialog-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Cancel</button><button className="primary-button" type="submit">Save assignment <ArrowRight size={15}/></button></div></form>:<form onSubmit={addReport}><label>Report title<input required value={reportForm.title} onChange={e=>setReportForm({...reportForm,title:e.target.value})} placeholder="e.g. Project notes"/></label><label>Report<textarea required value={reportForm.body} onChange={e=>setReportForm({...reportForm,body:e.target.value})} placeholder="Write your report or notes..." rows="5"/></label><label>Floor<select value={reportForm.floor} onChange={e=>setReportForm({...reportForm,floor:Number(e.target.value),assignmentId:'',agentId:''})}>{visibleIds.map(n=><option key={n} value={n}>Floor {pad(n)} — {FLOORS[n].name}</option>)}</select></label><label>Related project <span>OPTIONAL</span><select value={reportForm.assignmentId} onChange={e=>setReportForm({...reportForm,assignmentId:e.target.value})}><option value="">No project linked</option>{assignments.filter(a=>Number(a.floor)===Number(reportForm.floor)).map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label><label>Related agent <span>OPTIONAL</span><select value={reportForm.agentId} onChange={e=>setReportForm({...reportForm,agentId:e.target.value})}><option value="">Floor-level report</option>{Array.from({length:200},(_,i)=>agentFor(Number(reportForm.floor),i)).map(agent=><option value={agent.id} key={agent.id}>{agent.name} · {agent.department}</option>)}</select></label><div className="form-note">This report is a manual note saved locally in your browser.</div><div className="dialog-actions"><button type="button" className="outline-button" onClick={()=>setModal(null)}>Cancel</button><button className="primary-button" type="submit">Save report <ArrowRight size={15}/></button></div></form>}</div></Overlay>}
  </div>
}

createRoot(document.getElementById('root')).render(<App/>);
