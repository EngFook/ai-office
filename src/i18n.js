// i18n layer: the UI shows only one language at a time (default 中文), toggled in the header.
// Static strings are translated from DICT; text written by users/agents (task titles etc.) stays as-is.
import { useEffect, useState } from 'react';
import { DICT } from './i18n-dict.js';
export { DICT };
export const LANGS = ['zh', 'en'];
const KEY = 'office-lang';
let current = (() => { try { const v = globalThis.localStorage?.getItem(KEY); return LANGS.includes(v) ? v : 'zh'; } catch { return 'zh'; } })();
const listeners = new Set();
export const getLang = () => current;
export const uiLocale = () => current === 'zh' ? 'zh-SG' : 'en-SG';
export function setLang(lang) {
  if (!LANGS.includes(lang) || lang === current) return;
  current = lang; try { localStorage.setItem(KEY, lang); } catch {}
  if (globalThis.document) document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en';
  for (const fn of listeners) fn(lang);
}
export function useLang() {
  const [lang, set] = useState(current);
  useEffect(() => { listeners.add(set); return () => listeners.delete(set); }, []);
  return lang;
}
const esc = s => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');
const exact = new Map(), templates = [];
for (const entry of DICT) for (const side of LANGS) {
  const text = entry[side];
  if (/\{[a-z]\}/.test(text)) {
    const names = [...text.matchAll(/\{([a-z])\}/g)].map(m => m[1]);
    templates.push({ entry, side, names, re: new RegExp('^' + esc(text).replace(/\\?\{([a-z])\\?\}/g, '(.+?)') + '$') });
  } else if (!exact.has(text)) exact.set(text, entry);
}
function core(text, lang) {
  const hit = exact.get(text); if (hit) return hit[lang];
  for (const t of templates) { const m = text.match(t.re); if (!m) continue;
    // Placeholder values are opaque user/agent content, not UI dictionary keys.
    // Translating them could rename a project or task called "Review" or "Done".
    let out = t.entry[lang]; t.names.forEach((name, i) => { out = out.replace(`{${name}}`, () => m[i + 1]); }); return out; }
  return null;
}
// Translate a UI string into `lang`. Unknown text (e.g. user-written titles) is returned unchanged.
export function translate(text, lang = current) {
  if (typeof text !== 'string') return text;
  const m = text.match(/^(\s*)([\s\S]*?)(\s*)$/), body = m[2];
  if (!body || !/[A-Za-z\u4e00-\u9fff]/.test(body)) return text;
  let out = core(body, lang);
  if (out == null && body.includes(' · ')) { const parts = body.split(' · ').map(p => core(p, lang) ?? p); if (parts.some((p, i) => p !== body.split(' · ')[i])) out = parts.join(' · '); }
  if (out == null && body.includes(' / ')) { const parts = body.split(' / ').map(p => core(p, lang) ?? p); if (parts.some((p, i) => p !== body.split(' / ')[i])) out = parts.join(' / '); }
  return out == null ? text : m[1] + out + m[3];
}
export const t = text => translate(text, current);
export const hasEntry = text => core(text, 'zh') != null;

// DOM layer: translates React-rendered text and attributes (including portals and 3D scene labels).
// Elements marked data-no-i18n (user/agent content) are skipped.
const ATTRS = ['placeholder', 'aria-label', 'title', 'label'];
export function installDomTranslator(root = document.body) {
  const source = new WeakMap(), written = new WeakMap();
  const skip = node => node.parentElement?.closest?.('[data-no-i18n],script,style,textarea');
  const doText = node => {
    if (skip(node)) return;
    if (written.get(node) !== node.nodeValue) source.set(node, node.nodeValue);
    const next = translate(source.get(node), current);
    if (next !== node.nodeValue) node.nodeValue = next;
    written.set(node, node.nodeValue);
  };
  const doAttrs = el => { if (el.closest?.('[data-no-i18n]')) return; for (const a of ATTRS) { if (!el.hasAttribute?.(a)) continue;
    const key = `__i18n_${a}`, val = el.getAttribute(a);
    if (el[key + 'w'] !== val) el[key] = val;
    const next = translate(el[key], current); if (next !== val) el.setAttribute(a, next); el[key + 'w'] = el.getAttribute(a); } };
  const walk = node => {
    if (node.nodeType === 3) return doText(node);
    if (node.nodeType !== 1) return;
    doAttrs(node);
    const w = document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = w.nextNode(); n; n = w.nextNode()) n.nodeType === 3 ? doText(n) : doAttrs(n);
  };
  const observer = new MutationObserver(list => { for (const m of list) {
    if (m.type === 'characterData') doText(m.target);
    else if (m.type === 'attributes') doAttrs(m.target);
    else m.addedNodes.forEach(walk);
  } });
  observer.observe(root, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  walk(root);
  const relang = () => walk(root);
  listeners.add(relang);
  if (globalThis.document) document.documentElement.lang = current === 'zh' ? 'zh-CN' : 'en';
  return () => { observer.disconnect(); listeners.delete(relang); };
}
