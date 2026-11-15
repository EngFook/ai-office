import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer } from 'vite';
import { requestProjectPath, requestProviderOptions } from '../src/request-form.js';
import { taskProjects, filterBoardTasks, taskProjectDisplay, taskProjectKey } from '../src/task-board-ui.js';

let vite, cacheDir, ui, setLang;
before(async () => {
  cacheDir = await mkdtemp(path.join(tmpdir(), 'office-project-ui-'));
  vite = await createServer({ cacheDir, configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, server: { middlewareMode: true, hmr: false }, appType: 'custom' });
  ui = await vite.ssrLoadModule('/src/TaskBoard.jsx');
  ({ setLang } = await vite.ssrLoadModule('/src/i18n.js'));
  setLang('en');
});
after(async () => { if (vite) await vite.close(); if (cacheDir) await rm(cacheDir, { recursive: true, force: true }); });
const state = overrides => ({ tasks: [], roles: [], settings: { autoPickup: false }, runtime: { providers: {} }, projectCatalog: [], configuration: { workspace: '/work/Default', mode: 'enabled', providers: [{ id: 'codex', enabled: true }, { id: 'claude', enabled: false }, { id: 'gemini', enabled: true }] }, ...overrides });
const render = (component, props) => renderToStaticMarkup(React.createElement(component, props));

test('an intentional empty project never silently becomes the configured workspace', () => {
  assert.equal(requestProjectPath('', { workspace: '/work/Default' }), '');
  assert.equal(requestProjectPath(null, { workspace: '/work/Default' }), '/work/Default');
  assert.equal(requestProjectPath('/work/Other', { workspace: '/work/Default' }), '/work/Other');
});

test('provider draft choices reflect explicit configuration without hiding an existing owner', () => {
  const options = requestProviderOptions(state());
  assert.equal(options.find(option => option.id === 'codex').disabled, false);
  assert.equal(options.find(option => option.id === 'claude').disabled, true);
  assert.equal(options.find(option => option.id === 'gemini').disabled, false);
  assert.equal(requestProviderOptions(state(), 'claude').find(option => option.id === 'claude').configuredDisabled, true);
  assert.equal(requestProviderOptions(state({ runtime: { providers: { 'local-qwen': { disabled: true } } } })).find(option => option.id === 'local-qwen').disabled, true);
});

test('catalog grouping only creates registered project cards while every task stays accessible', () => {
  const catalog = [{ id: 'a', name: 'A', path: '/work/A', folders: ['/tmp/A-worktree'] }];
  const tasks = [{ id: 'a', projectPath: '/work/A' }, { id: 'tree', projectPath: '/tmp/A-worktree/src' }, { id: 'b', projectPath: '/work/B' }, { id: 'text', provider: 'local-qwen', supportType: 'log-triage', role: 'Helper', description: 'actual supplied output', projectPath: '' }];
  const projects = taskProjects(tasks, catalog);
  assert.equal(projects.length, 1);
  assert.equal(projects[0].count, 2);
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '/work/A', catalog }).map(task => task.id), ['a', 'tree']);
  assert.deepEqual(filterBoardTasks(tasks, { catalog }), tasks);
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '/work/B', catalog }).map(task => task.id), ['b']);
  assert.deepEqual(filterBoardTasks(tasks, { projectPath: '', catalog }).map(task => task.id), ['text']);
  assert.equal(taskProjects([], catalog)[0].count, 0);
});

test('research is grouped by its selected project while the isolated execution folder stays unchanged', () => {
  const task = { id: 'research', provider: 'gemini', projectPath: '/private/office/research', contextProjectPath: '/work/Selected', status: 'pending' };
  const before = structuredClone(task);
  assert.deepEqual(taskProjects([task]), []);
  assert.equal(taskProjects([task], [{ path: '/work/Selected', name: 'Selected' }])[0].path, '/work/Selected');
  assert.equal(taskProjectDisplay(task).detail, '/work/Selected');
  assert.equal(filterBoardTasks([task], { projectPath: '/work/Selected' }).length, 1);
  assert.equal(filterBoardTasks([task], { projectPath: '/private/office/research' }).length, 0);
  assert.deepEqual(task, before);
});

test('registered path boundaries support filesystem roots and Windows separator variants', () => {
  assert.equal(taskProjectKey('/work/A', [{ id: 'root', path: '/', name: 'Root' }]), '/');
  const catalog = [{ id: 'windows', path: 'C:\\Projects\\Demo\\', name: 'Demo' }];
  assert.equal(taskProjectKey('C:/Projects/Demo/src', catalog), 'C:/Projects/Demo');
  assert.equal(taskProjectKey('C:/Projects/Demo-other/src', catalog), 'C:/Projects/Demo-other/src');
  assert.equal(taskProjects([{ projectPath: 'C:/Projects/Demo/src' }], catalog).length, 1);
});

test('new request exposes instructions and provider before opening advanced settings', () => {
  const html = render(ui.NewRequest, { board: { state: state() }, projectPath: '', onClose() {} });
  assert.match(html, /<textarea/);
  assert.match(html, /Agent preference/);
  assert.match(html, /value="claude" disabled=""/);
  assert.match(html, /value=""/);
  assert.doesNotMatch(html, /value="\/work\/Default"/);
  assert.doesNotMatch(html, /id="tb-new-request-advanced"/);
});

test('Gemini creates and edits the selected project context rather than hiding the folder input', () => {
  const current = state({ projectCatalog: [{ id: 'a', path: '/work/Selected', name: 'Selected' }] });
  const created = render(ui.NewRequest, { board: { state: current }, projectPath: '/work/Selected', provider: 'gemini', onClose() {} });
  assert.match(created, /Project folder/);
  assert.match(created, /value="\/work\/Selected"/);
  assert.match(created, /<datalist/);
  const edited = render(ui.RequestFields, { state: current, roles: [], value: { title: 'Research', description: 'Question', provider: 'gemini', role: 'Helper', priority: 'normal', projectPath: '/private/research', contextProjectPath: '/work/Selected' }, onChange() {} });
  assert.match(edited, /value="\/work\/Selected"/);
  assert.doesNotMatch(edited, /value="\/private\/research"/);
});

test('empty project list has a real add-project action only when permitted', () => {
  const html = render(ui.TaskProjects, { board: { state: state(), loading: false }, onAddProject() {} });
  assert.match(html, /No projects yet/);
  assert.match(html, />Add project</);
  const readOnly = render(ui.TaskProjects, { board: { state: state({ capabilities: { projects: false } }) }, onAddProject() {} });
  assert.doesNotMatch(readOnly, />Add project</);
});

test('project page shows exactly the registered projects despite five extra task worktrees', () => {
  const projectCatalog = [{ id: 'a', path: '/work/A', name: 'Registered A' }, { id: 'b', path: '/work/B', name: 'Registered B' }];
  const tasks = Array.from({ length: 5 }, (_, index) => ({ id: `extra-${index}`, projectPath: `/tmp/Unregistered-${index}`, title: `Existing task ${index}` }));
  tasks.push({ id: 'text', provider: 'local-qwen', projectPath: '', description: 'Supplied text' });
  const html = render(ui.TaskProjects, { board: { state: state({ projectCatalog, tasks }), loading: false }, onAddProject() {} });
  assert.equal((html.match(/class="tb-project-card"/g) || []).length, 2);
  assert.match(html, /Registered A/); assert.match(html, /Registered B/);
  assert.doesNotMatch(html, /Unregistered-/);
  assert.equal(filterBoardTasks(tasks).length, 6);
  for (const emptyCatalog of [[], undefined]) {
    const empty = render(ui.TaskProjects, { board: { state: state({ projectCatalog: emptyCatalog, tasks }), loading: false }, onAddProject() {} });
    assert.match(empty, /No projects yet/);
    assert.match(empty, />Add project</);
    assert.doesNotMatch(empty, /class="tb-project-card"/);
  }
});

test('project form tells remote users which computer owns the directory and does not start tasks', () => {
  const html = render(ui.NewProject, { board: { state: state() }, onClose() {} });
  assert.match(html, /Full project folder path/);
  assert.match(html, /does not create or move files, or start an agent/);
  assert.match(html, /not the phone or device viewing it/);
});

test('setup instructions run inside the office installation and unsupported Gemini is not ready', async () => {
  const { default: OfficeSetupStatus } = await vite.ssrLoadModule('/src/OfficeSetupStatus.jsx');
  const html = render(OfficeSetupStatus, { configuration: { configured: false, providers: [{ id: 'gemini', enabled: true }] }, runtime: { providers: { gemini: { available: true, authenticated: true, modelSupported: false } } } });
  assert.match(html, /AI Office installation folder/);
  assert.match(html, /1 enabled · 0 ready/);
  assert.doesNotMatch(html, /From the project folder in your terminal/);
});

test('blocked or full browser storage falls back without crashing the office', async () => {
  const { browserStorage, readBrowserValue, writeBrowserValue, localNoteRecords } = await import('../src/browser-storage.js');
  const deniedHost = Object.defineProperty({}, 'localStorage', { get() { throw new Error('Storage access denied'); } });
  assert.equal(browserStorage(deniedHost), null);
  assert.deepEqual(readBrowserValue('notes', [], null), []);
  assert.equal(writeBrowserValue('notes', [{ title: 'Keep this note' }], null), false);
  const full = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('QuotaExceededError'); } };
  assert.deepEqual(readBrowserValue('notes', [], full), []);
  assert.equal(writeBrowserValue('notes', [], full), false);
  const notes = [{ id: 'valid', body: 'Original note' }, null, false, 42, [], 'broken'];
  assert.deepEqual(localNoteRecords(notes), [notes[0]]);
  let stored;
  const storage = { setItem(_key, value) { stored = value; }, getItem() { return stored; } };
  assert.equal(writeBrowserValue('notes', notes.slice(0, 1), storage), true);
  assert.deepEqual(readBrowserValue('notes', [], storage), notes.slice(0, 1));
});
