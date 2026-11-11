// Shared by the browser app and the local API server (no JSX, no browser APIs).

// The 3D scene has three hand-built floor plans. Every floor picks one of them.
export const LAYOUTS = {
  1: { name: 'Maker studio', identity: 'The maker studio', floorStory: 'Paired engineering benches bring building and testing together.' },
  2: { name: 'Research atelier', identity: 'The research atelier', floorStory: 'Two-person research nooks and a library lounge make room to think.' },
  3: { name: 'Creative lab', identity: 'The creative strategy lab', floorStory: 'Circular work clusters and a studio lounge invite fresh perspectives.' },
}

export const PROVIDERS = {
  gemini: { label: 'Google Gemini (AI Studio key)', defaultModel: 'gemini-3.8-flash', keyEnv: 'GEMINI_API_KEY', needsBaseUrl: false },
  // Gemini billed to a Google Cloud project; signs in with VERTEX_CREDENTIALS from .env instead of an API key.
  vertex: { label: 'Google Vertex AI (Cloud project)', defaultModel: 'gemini-3.8-flash', keyEnv: 'VERTEX_CREDENTIALS', needsBaseUrl: false, noKey: true },
  openai: { label: 'OpenAI-compatible (OpenAI, xAI Grok, OpenRouter, Ollama…)', defaultModel: 'gpt-5', keyEnv: 'OPENAI_API_KEY', needsBaseUrl: true, defaultBaseUrl: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic Claude', defaultModel: 'claude-sonnet-5-5', keyEnv: 'ANTHROPIC_API_KEY', needsBaseUrl: false },
  // Runs the local `claude` CLI headless, using whoever is signed in to Claude Code on this computer.
  'claude-cli': { label: 'Claude Code CLI (your Claude sign-in)', defaultModel: 'sonnet', keyEnv: '', needsBaseUrl: false, noKey: true },
  none: { label: 'Not connected', defaultModel: '', keyEnv: '', needsBaseUrl: false },
}

export const DEFAULT_FLOORS = [
  { id: 1, name: 'GPT Codex', short: 'GPT', letter: 'G', color: '#68d7b0', layout: 1, hidden: false,
    department: 'Engineering & execution', label: 'BUILD & SHIP', description: 'A hands-on home for turning ideas into working software.',
    departments: ['Engineering', 'Product', 'Quality', 'Operations'],
    provider: { type: 'openai', model: 'gpt-5', baseUrl: 'https://api.openai.com/v1', systemPrompt: '' } },
  { id: 2, name: 'Claude Code', short: 'Claude', letter: 'C', color: '#eda47f', layout: 2, hidden: false,
    department: 'Research & analysis', label: 'THINK & ANALYSE', description: 'A thoughtful setting for research, review and analysis.',
    departments: ['Research', 'Architecture', 'Code Review', 'Documentation'],
    provider: { type: 'anthropic', model: 'claude-sonnet-5-5', baseUrl: '', systemPrompt: '' } },
  { id: 3, name: 'Grok', short: 'Grok', letter: 'X', color: '#a99af5', layout: 3, hidden: false,
    department: 'Strategy & exploration', label: 'EXPLORE & DISCOVER', description: 'An exploratory space for new ideas and opportunities.',
    departments: ['Strategy', 'Insights', 'Creative', 'Innovation'],
    provider: { type: 'openai', model: 'grok-4', baseUrl: 'https://api.x.ai/v1', systemPrompt: '' } },
]

const text = (value, fallback, max = 200) => (typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : fallback)

// Fill in anything missing so older or hand-edited configs still render.
export function normalizeFloor(input, id) {
  const layout = [1, 2, 3].includes(Number(input?.layout)) ? Number(input.layout) : 1
  const name = text(input?.name, `Floor ${id}`, 60)
  const departments = Array.from({ length: 4 }, (_, i) => text(input?.departments?.[i], `Team ${i + 1}`, 40))
  const p = input?.provider || {}
  const type = PROVIDERS[p.type] ? p.type : 'none'
  return {
    id,
    name,
    short: text(input?.short, name.split(' ')[0], 16),
    letter: text(input?.letter, name[0].toUpperCase(), 2),
    color: /^#[0-9a-f]{6}$/i.test(input?.color || '') ? input.color : '#8fc9aa',
    layout,
    hidden: !!input?.hidden,
    department: text(input?.department, departments.slice(0, 2).join(' & '), 60),
    label: text(input?.label, name.toUpperCase(), 40),
    description: text(input?.description, 'A configurable floor for your AI team.', 300),
    identity: text(input?.identity, LAYOUTS[layout].identity, 60),
    floorStory: text(input?.floorStory, LAYOUTS[layout].floorStory, 300),
    departments,
    provider: {
      type,
      model: text(p.model, PROVIDERS[type].defaultModel, 100),
      baseUrl: text(p.baseUrl, PROVIDERS[type].defaultBaseUrl || '', 300),
      systemPrompt: text(p.systemPrompt, '', 4000),
      access: p.access === 'edit' ? 'edit' : 'read', // Claude CLI only: may it edit files in the project folder?
      // Only the server sets these two; the browser never sees the key itself.
      hasKey: !!p.hasKey,
      keyHint: typeof p.keyHint === 'string' ? p.keyHint : '',
    },
  }
}
