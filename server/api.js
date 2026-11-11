// Local API used by the office UI. Runs inside the Vite dev/preview server (see vite.config.js).
// API keys are stored in data/floors.json (gitignored) or read from environment variables,
// and are never sent back to the browser.
import { spawn, spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_FLOORS, PROVIDERS, normalizeFloor } from '../src/floor-config.js'

const DATA_FILE = path.resolve(process.env.AI_OFFICE_DATA || 'data/floors.json')

function load() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'))
    if (Array.isArray(saved) && saved.length) return saved
  } catch {}
  return structuredClone(DEFAULT_FLOORS)
}

function save(floors) {
  fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true })
  fs.writeFileSync(DATA_FILE, JSON.stringify(floors, null, 2), { mode: 0o600 })
}

function keyFor(floor) {
  const p = floor.provider || {}
  if (p.type === 'claude-cli') return claudeBin() ? 'cli' : ''
  if (p.type === 'vertex') return vertexFile() && fs.existsSync(vertexFile()) ? 'vertex' : ''
  return p.apiKey || (PROVIDERS[p.type]?.keyEnv && process.env[PROVIDERS[p.type].keyEnv]) || ''
}

// ---- Vertex AI: Gemini billed to a Google Cloud project (same setup as the ai-company console) ----
// VERTEX_CREDENTIALS points to an "authorized_user" sign-in file (gcloud's application_default_credentials.json
// works too) or a service-account key JSON. VERTEX_PROJECT overrides the project; VERTEX_LOCATION defaults to global.
const vertexFile = () => process.env.VERTEX_CREDENTIALS ? path.resolve(process.env.VERTEX_CREDENTIALS) : ''
const vertexToken = { value: '', expires: 0 }

async function vertexAccess() {
  const creds = JSON.parse(fs.readFileSync(vertexFile(), 'utf8'))
  const project = process.env.VERTEX_PROJECT || creds.project_id || creds.quota_project_id
  if (!project) throw new Error('Vertex: set VERTEX_PROJECT in .env')
  if (!vertexToken.value || Date.now() > vertexToken.expires - 300_000) {
    let body
    if (creds.type === 'service_account') {
      const now = Math.floor(Date.now() / 1000)
      const b64 = obj => Buffer.from(JSON.stringify(obj)).toString('base64url')
      const unsigned = `${b64({ alg: 'RS256', typ: 'JWT', kid: creds.private_key_id })}.${b64({ iss: creds.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: creds.token_uri, iat: now, exp: now + 3600 })}`
      const signature = crypto.sign('RSA-SHA256', Buffer.from(unsigned), creds.private_key).toString('base64url')
      body = { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }
    } else {
      body = { client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' }
    }
    const res = await fetch(creds.token_uri || 'https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams(body) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(`Vertex sign-in failed: ${data.error_description || data.error || res.status}. Sign in again (see README).`)
    Object.assign(vertexToken, { value: data.access_token, expires: Date.now() + (data.expires_in || 3600) * 1000 })
  }
  const loc = process.env.VERTEX_LOCATION || 'global'
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`
  return { token: vertexToken.value, baseUrl: `https://${host}/v1/projects/${project}/locations/${loc}/endpoints/openapi` }
}

// Public view: normalized, with the key replaced by a flag and its last 4 characters.
function publicFloor(floor) {
  const key = keyFor(floor)
  const fromEnv = !floor.provider?.apiKey && !!key
  const hint = !key ? '' : floor.provider.type === 'claude-cli' ? 'Claude Code sign-in' : floor.provider.type === 'vertex' ? 'from VERTEX_CREDENTIALS' : fromEnv ? `from ${PROVIDERS[floor.provider.type].keyEnv}` : `…${key.slice(-4)}`
  return normalizeFloor({ ...floor, provider: { ...floor.provider, hasKey: !!key, keyHint: hint } }, floor.id)
}

// Merge an edit from the browser into a stored floor. A blank apiKey keeps the existing key.
function applyEdit(stored, body, id) {
  const next = normalizeFloor({ ...stored, ...body, provider: { ...stored?.provider, ...body.provider } }, id)
  delete next.provider.hasKey
  delete next.provider.keyHint
  const incoming = body.provider?.apiKey
  if (body.provider?.clearKey) next.provider.apiKey = ''
  else if (typeof incoming === 'string' && incoming.trim()) next.provider.apiKey = incoming.trim()
  else next.provider.apiKey = stored?.provider?.apiKey || ''
  return next
}

// ---- Claude Code CLI: `claude -p` headless, signed in as whoever uses Claude Code on this computer ----
// Project folders must be under AI_OFFICE_WORKSPACE_ROOT (default ~/Projects). Shell commands are never allowed.
let claudePath
function claudeBin() {
  if (claudePath === undefined) {
    const candidate = process.env.CLAUDE_BIN || 'claude'
    claudePath = spawnSync(candidate, ['--version'], { encoding: 'utf8' }).status === 0 ? candidate : null
  }
  return claudePath
}
const workspaceRoot = () => path.resolve(process.env.AI_OFFICE_WORKSPACE_ROOT || path.join(os.homedir(), 'Projects'))

// The folder Claude works in: the project's local path if it is one, otherwise a scratch folder.
function claudeWorkdir(repo) {
  const raw = (repo || '').trim()
  if (raw && !/^https?:\/\//i.test(raw)) {
    const dir = path.resolve(raw.replace(/^~(?=$|\/)/, os.homedir()))
    const root = workspaceRoot()
    if (dir !== root && !dir.startsWith(root + path.sep)) throw new Error(`Claude can only work in folders under ${root} (set AI_OFFICE_WORKSPACE_ROOT to change this).`)
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Project folder not found: ${dir}`)
    return { dir, isProject: true }
  }
  const dir = path.resolve('data/claude-scratch')
  fs.mkdirSync(dir, { recursive: true })
  return { dir, isProject: false }
}

function runClaude(floor, system, prompt, workdir) {
  const edit = floor.provider.access === 'edit' && workdir.isProject
  const tools = ['Read', 'Grep', 'Glob', 'WebSearch', 'WebFetch', ...(edit ? ['Edit', 'Write'] : [])]
  const args = ['-p', '--output-format', 'json', '--model', floor.provider.model || 'sonnet', '--append-system-prompt', system,
    '--permission-mode', edit ? 'acceptEdits' : 'dontAsk', '--allowedTools', ...tools, '--disallowedTools', 'Bash']
  return new Promise((resolve, reject) => {
    const child = spawn(claudeBin(), args, { cwd: workdir.dir, stdio: ['pipe', 'pipe', 'pipe'] })
    let out = '', err = ''
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Claude took longer than 20 minutes and was stopped.')) }, 20 * 60_000)
    child.stdout.on('data', d => { out += d })
    child.stderr.on('data', d => { err += d })
    child.on('error', e => { clearTimeout(timer); reject(e) })
    child.on('close', code => {
      clearTimeout(timer)
      let data
      try { data = JSON.parse(out) } catch { return reject(new Error((err || out || `claude exited with code ${code}`).trim().slice(0, 500))) }
      if (data.is_error) return reject(new Error(String(data.result || data.subtype || 'Claude reported an error').slice(0, 500)))
      resolve(data.result || '')
    })
    child.stdin.end(prompt)
  })
}

async function callModel(floor, system, prompt, maxTokens = 4096, workdir = null) {
  const { type, model, baseUrl } = floor.provider || {}
  const key = keyFor(floor)
  if (!type || type === 'none') throw new Error('This floor has no LLM provider configured.')
  if (type === 'claude-cli') {
    if (!key) throw new Error('The claude command was not found. Install Claude Code, run `claude` once and sign in with /login.')
    return runClaude(floor, system, prompt, workdir || claudeWorkdir(''))
  }
  if (type === 'vertex' && !key) throw new Error('Vertex: set VERTEX_CREDENTIALS in .env to your sign-in or service-account file (see README).')
  if (!key && !(type === 'openai' && /localhost|127\.0\.0\.1/.test(baseUrl || ''))) throw new Error('No API key set for this floor.')
  const signal = AbortSignal.timeout(180_000)
  let res, data
  if (type === 'gemini') {
    res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        generationConfig: { maxOutputTokens: maxTokens },
      }),
    })
    data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error?.message || `Gemini returned HTTP ${res.status}`)
    const out = data.candidates?.[0]?.content?.parts?.map(part => part.text || '').join('') || ''
    if (!out) throw new Error(`Gemini returned no text (${data.candidates?.[0]?.finishReason || data.promptFeedback?.blockReason || 'unknown reason'}).`)
    return out
  }
  if (type === 'anthropic') {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: prompt }] }),
    })
    data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error?.message || `Anthropic returned HTTP ${res.status}`)
    return (data.content || []).filter(block => block.type === 'text').map(block => block.text).join('')
  }
  // OpenAI-compatible chat completions (OpenAI, xAI, OpenRouter, Ollama, LM Studio… and Vertex's OpenAI endpoint)
  const vertex = type === 'vertex' ? await vertexAccess() : null
  const bearer = vertex ? vertex.token : key
  res = await fetch(`${(vertex ? vertex.baseUrl : baseUrl || PROVIDERS.openai.defaultBaseUrl).replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST', signal,
    headers: { 'content-type': 'application/json', ...(bearer ? { authorization: `Bearer ${bearer}` } : {}) },
    body: JSON.stringify({ model: vertex && !model.includes('/') ? `google/${model}` : model, messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
  })
  data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error((Array.isArray(data) ? data[0] : data).error?.message || `Provider returned HTTP ${res.status}`)
  return data.choices?.[0]?.message?.content || ''
}

function agentSystemPrompt(floor, agentName, department, workdir) {
  const who = agentName ? `You are ${agentName}, a member of the ${department || 'floor'} department` : `You are the ${floor.name} team`
  const cli = floor.provider?.type === 'claude-cli'
  const canEdit = cli && workdir?.isProject && floor.provider.access === 'edit'
  return [
    `${who} on the "${floor.name}" floor of The AI Office (${floor.department}).`,
    `Floor focus: ${floor.description}`,
    floor.provider?.systemPrompt,
    'You receive a project assignment from your manager. Work on it and reply with a concise, well-structured report:',
    'what you did, your result or recommendation, and any open questions or next steps. Use Markdown.',
    cli
      ? (workdir?.isProject
        ? `You are working in the project folder ${workdir.dir}. You can read its files${canEdit ? ' and edit them; list every file you changed in your report' : ' but must not change anything'}. You cannot run shell commands.`
        : 'You may search the web. There is no project folder for this task, so do not create files.')
      : 'You cannot browse the web or open repositories; if a link is given, say what you would need from it.',
  ].filter(Boolean).join('\n')
}

// ---- CEO: turns a goal into tasks for the floors, and summarizes the results ----
function roster(floors) {
  return floors.filter(f => !f.hidden && keyFor(f) && f.provider?.type !== 'none').map(f => {
    const n = normalizeFloor(f, f.id)
    const ability = n.provider.type === 'claude-cli'
      ? `can read${n.provider.access === 'edit' ? ' and edit' : ''} local project folders under ${workspaceRoot()} and search the web`
      : 'text only: cannot open files, repositories or the web'
    return `- floorId ${n.id} "${n.name}" (model ${n.provider.model}; ${ability}). Focus: ${n.department}. ${n.description} Departments: ${n.departments.join(', ')}.`
  }).join('\n')
}

function ceoSystemPrompt(floors, ceoFloor) {
  return [
    `You are the CEO of The AI Office. You report to the founder, who chats with you. You run on the "${ceoFloor.name}" floor.`,
    'Your job: understand the founder\'s goal, ask a short clarifying question only when the goal is truly ambiguous, and otherwise',
    'break it into 1-6 concrete, independent tasks and assign each to the best floor and department below. Tasks run in parallel and',
    'cannot see each other\'s results, so make each brief self-contained with clear deliverables. Only use floors from this list:',
    roster(floors) || '(no connected floors)',
    ceoFloor.provider?.systemPrompt,
    'Respond with ONLY a JSON object, no other text:',
    '{"reply": "<short message to the founder, Markdown allowed>", "tasks": [{"title": "<short name>", "brief": "<what to do and what to deliver>", "floorId": <number>, "department": "<one of that floor\'s departments>", "repo": "<local folder path or URL, or empty>"}]}',
    'Use an empty tasks array when you are only answering or asking a question. Only set repo when the founder gave a path or link.',
  ].filter(Boolean).join('\n')
}

function parseCeo(text) {
  const start = text.indexOf('{'), end = text.lastIndexOf('}')
  try {
    const data = JSON.parse(text.slice(start, end + 1))
    return { reply: String(data.reply || ''), tasks: Array.isArray(data.tasks) ? data.tasks.slice(0, 8) : [] }
  } catch {
    return { reply: text.trim(), tasks: [] }
  }
}

async function readBody(req) {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 200_000) throw Object.assign(new Error('Request too large'), { status: 413 })
  }
  return raw ? JSON.parse(raw) : {}
}

const send = (res, status, body) => {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(body))
}

export async function handleApi(req, res, next) {
  const url = new URL(req.url, 'http://local')
  if (!url.pathname.startsWith('/api/')) return next()
  try {
    const floors = load()
    const match = /^\/api\/floors\/(\d+)(\/test)?$/.exec(url.pathname)
    const id = match ? Number(match[1]) : null
    const index = id == null ? -1 : floors.findIndex(f => f.id === id)

    if (url.pathname === '/api/floors' && req.method === 'GET') return send(res, 200, floors.map(publicFloor))

    if (url.pathname === '/api/floors' && req.method === 'POST') {
      const body = await readBody(req)
      const newId = Math.max(0, ...floors.map(f => f.id)) + 1
      const floor = applyEdit(null, body, newId)
      save([...floors, floor])
      return send(res, 201, publicFloor(floor))
    }

    if (match && !match[2] && req.method === 'PUT') {
      if (index < 0) return send(res, 404, { error: 'Floor not found' })
      const body = await readBody(req)
      const updated = applyEdit(floors[index], body, id)
      if (updated.hidden && floors.filter(f => !f.hidden && f.id !== id).length === 0) return send(res, 400, { error: 'At least one floor must stay visible.' })
      floors[index] = updated
      save(floors)
      return send(res, 200, publicFloor(updated))
    }

    if (match?.[2] && req.method === 'POST') {
      if (index < 0) return send(res, 404, { error: 'Floor not found' })
      const reply = await callModel(floors[index], 'Reply with exactly: OK', 'Connection test.', 64)
      return send(res, 200, { ok: true, reply: reply.trim().slice(0, 200) })
    }

    if (url.pathname === '/api/run' && req.method === 'POST') {
      const body = await readBody(req)
      const floor = floors.find(f => f.id === Number(body.floorId))
      if (!floor) return send(res, 404, { error: 'Floor not found' })
      const normalized = normalizeFloor(floor, floor.id)
      const prompt = [
        `Project: ${body.project?.name || 'Untitled'}`,
        body.project?.repo && `Repository / path: ${body.project.repo}`,
        `Brief:\n${body.project?.brief || '(No brief given — propose a sensible first step.)'}`,
      ].filter(Boolean).join('\n\n')
      const workdir = normalized.provider.type === 'claude-cli' ? claudeWorkdir(body.project?.repo) : null
      const text = await callModel({ ...floor, provider: { ...normalized.provider, apiKey: floor.provider?.apiKey } }, agentSystemPrompt(normalized, body.agentName, body.department, workdir), prompt, 4096, workdir)
      return send(res, 200, { text, model: normalized.provider.model, provider: normalized.provider.type })
    }

    if (url.pathname === '/api/ceo' && req.method === 'POST') {
      const body = await readBody(req)
      const ceo = floors.find(f => f.id === Number(body.floorId))
      if (!ceo) return send(res, 404, { error: 'Choose a connected floor to power the CEO.' })
      const transcript = (body.messages || []).slice(-20).map(m => `${m.role === 'user' ? 'Founder' : 'CEO'}: ${m.content}`).join('\n\n')
      if (body.mode === 'summary') {
        const reports = (body.reports || []).map(r => `### ${r.title}\n${String(r.body || '').slice(0, 8000)}`).join('\n\n')
        const text = await callModel(ceo, `You are the CEO of The AI Office, reporting to the founder. ${ceo.provider?.systemPrompt || ''}`,
          `Conversation so far:\n${transcript}\n\nYour team finished the tasks for the goal "${body.goal || ''}". Their reports:\n\n${reports}\n\nWrite the founder a concise summary in Markdown: the answer or outcome, key findings, any failed tasks, and recommended next steps.`)
        return send(res, 200, { reply: text, tasks: [] })
      }
      const text = await callModel(ceo, ceoSystemPrompt(floors, ceo), `${transcript}\n\nCEO (reply as JSON):`)
      const parsed = parseCeo(text)
      const valid = new Set(floors.filter(f => !f.hidden && keyFor(f)).map(f => f.id))
      parsed.tasks = parsed.tasks.filter(t => t && t.title && valid.has(Number(t.floorId))).map(t => ({
        title: String(t.title).slice(0, 120), brief: String(t.brief || '').slice(0, 4000), floorId: Number(t.floorId),
        department: String(t.department || ''), repo: String(t.repo || '').slice(0, 500),
      }))
      return send(res, 200, parsed)
    }

    return send(res, 404, { error: 'Unknown API route' })
  } catch (error) {
    return send(res, error.status || 502, { error: error.name === 'TimeoutError' ? 'The model took too long to answer.' : error.message })
  }
}

export function officeApi() {
  return {
    name: 'ai-office-api',
    configureServer(server) { server.middlewares.use(handleApi) },
    configurePreviewServer(server) { server.middlewares.use(handleApi) },
  }
}
