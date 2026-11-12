import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useLang } from './i18n.js';
import './grok-conversation.css';

const EMPTY = { phase: 'empty', messages: [], bots: [], hasMore: false };
export function reconcileGrokSnapshot(prior, incoming, { older = false, automatic = false, follow = true } = {}) {
  // A saved source may change while the user reads an older page. Keep that
  // explicitly stale snapshot on screen until they choose to refresh it.
  if ((older && incoming.error === 'STALE_CURSOR') || (automatic && !follow && prior.messages?.length && incoming.phase === 'ready' && incoming.revision !== prior.revision)) {
    return { ...prior, newCacheAvailable: true, hasMore: false, nextCursor: null };
  }
  let value = incoming;
  if (value.phase === 'ready' && prior.revision === value.revision) {
    if (older) value = { ...value, messages: [...value.messages, ...prior.messages] };
    else value = { ...value, messages: prior.messages, hasMore: prior.hasMore, nextCursor: prior.nextCursor };
  }
  return { ...value, messages: [...new Map(value.messages.map(message => [message.id, message])).values()] };
}
const textFor = (zh, kind) => (zh ? { attachment: '附件保留在 Grok Bot 中；这里不读取附件内容。', 'secret-request': '凭据请求已隐藏，请在 Grok Bot 中处理。', 'voice-call': '语音通话：以下为本机缓存的文字转录。', unsupported: '此消息格式暂不支持，请在 Grok Bot 中查看。', event: '应用事件，请在 Grok Bot 中查看详情。' } : { attachment: 'Attachment remains in Grok Bot; its content is not read here.', 'secret-request': 'Credential request hidden. Handle it in Grok Bot.', 'voice-call': 'Voice call: locally cached transcript follows.', unsupported: 'Unsupported message format. View it in Grok Bot.', event: 'App event. View its details in Grok Bot.' })[kind] || (zh ? '请在 Grok Bot 中查看。' : 'View in Grok Bot.');
export function GrokConversationView({ conversation = EMPTY, loading = false, onRefresh, onOlder, onSelect, logRef, lang }) {
  const currentLang = useLang(), zh = (lang || currentLang) === 'zh';
  const unavailable = conversation.phase === 'unavailable';
  const messages = unavailable ? [] : conversation.messages || [];
  return <section className="grok-conversation" data-no-i18n aria-label={zh ? '你与 Grok Bot 的真实对话（只读）' : 'Your actual Grok Bot conversation (read only)'}>
    <header className="grok-conversation__heading"><div><h3>{zh ? '你 ↔ Grok Bot' : 'You ↔ Grok Bot'}</h3><p>{zh ? '读取 Grok Bot 本机对话缓存 · 只读' : 'Reads Grok Bot’s local conversation cache · read only'}</p></div><button type="button" disabled={loading} onClick={onRefresh}>{zh ? '刷新对话' : 'Refresh conversation'}</button></header>
    {(conversation.bots || []).length > 1 && <label className="grok-conversation__select">{zh ? 'Bot 对话' : 'Bot conversation'}<select value={conversation.botId || ''} disabled={loading} onChange={event => onSelect?.(event.target.value)}>{conversation.bots.map(bot => <option key={bot.id} value={bot.id}>{bot.name}</option>)}</select></label>}
    <p className="grok-conversation__notice">{zh ? '这里展示原应用保存的消息，不会替你发送聊天。每 15 秒读取缓存；新消息须由 Grok Bot 应用先保存。密钥会遮盖，附件与凭据请求留在原应用。' : 'Shows messages saved by the original app. It never sends chat on your behalf. Reads every 15 seconds; new messages must first be saved by Grok Bot. Credentials are redacted; attachments and secret requests remain in the original app.'}</p>
    {conversation.cachedAt && <p className="grok-conversation__source">{zh ? '源缓存更新：' : 'Source cache updated: '}{new Date(conversation.cachedAt).toLocaleString()} · {zh ? '办公室读取：' : 'Office checked: '}{new Date(conversation.checkedAt).toLocaleTimeString()}<br/>{zh ? `缓存 ${conversation.sourceEntryCount} 条源记录 · 当前显示 ${messages.length} / ${conversation.visibleMessageCount} 条可展示记录` : `${conversation.sourceEntryCount} cached source entries · showing ${messages.length} / ${conversation.visibleMessageCount} display records`}</p>}
    {conversation.sourceAgeMs > 300000 && <p className="grok-conversation__coverage" role="status">{zh ? `源缓存已 ${Math.floor(conversation.sourceAgeMs / 60000)} 分钟未更新：原应用可能空闲或尚未保存新消息，当前不能认定为实时同步。` : `The source cache has not changed for ${Math.floor(conversation.sourceAgeMs / 60000)} minutes. The app may be idle or may not have saved new messages; this is not confirmed live synchronization.`}</p>}
    {conversation.newCacheAvailable && <p className="grok-conversation__coverage" role="status">{zh ? '源缓存有更新。暂时保留你正在阅读的旧片段，点击「刷新对话」查看最新缓存。' : 'The source cache changed. Your older reading view has been preserved. Choose “Refresh conversation” to load the latest cache.'}</p>}
    {conversation.phase === 'ready' && <p className="grok-conversation__coverage" role="status">{conversation.earlierHistoryOmitted ? (zh ? '较早聊天未在本机缓存中，当前不是完整历史。原应用没有提供的记录无法在这里补齐。' : 'Earlier chats are absent from this local cache. This is not the full history; records missing from the source cannot be filled in here.') : (zh ? '已读取当前本机缓存；尚无法核实是否覆盖云端全部历史。' : 'Current local cache has been read; coverage of all cloud history cannot be verified.')}</p>}
    {loading && <p className="grok-conversation__notice" role="status">{zh ? '正在读取对话…' : 'Reading conversation…'}</p>}
    {unavailable ? <p className="grok-conversation__error" role="alert">{zh ? '真实对话读取失败，未显示旧缓存。请刷新或在 Grok Bot 中打开对话。' : 'Could not read the actual conversation; stale content has been cleared. Refresh or open the conversation in Grok Bot.'} {conversation.error}</p> : messages.length ? <>
      {conversation.hasMore && <button type="button" disabled={loading} onClick={onOlder}>{zh ? '加载较早的缓存消息' : 'Load earlier cached messages'}</button>}
      <ol className="grok-conversation__messages" tabIndex={0} ref={logRef} aria-label={zh ? 'Grok 原始对话记录' : 'Original Grok conversation history'}>
        {messages.map(message => <li key={message.id} className={`grok-conversation__message is-${message.role}`}>
          <div className="grok-conversation__meta"><strong>{message.role === 'user' ? (zh ? '你' : 'You') : message.role === 'grok-bot' ? 'Grok Bot' : (zh ? '应用记录' : 'App record')}</strong><time dateTime={message.timestamp}>{new Date(message.timestamp).toLocaleString()}</time></div>
          <p>{message.placeholder ? textFor(zh, message.kind) : message.text}</p>
          {message.streaming && <small>{zh ? '原应用正在生成…' : 'Generating in the original app…'}</small>}
          {message.textTruncated && <small>{zh ? '长消息超出展示上限，请在原应用查看全文。' : 'Long message exceeds the display limit. Open the original app for the full text.'}</small>}
          {message.kind === 'widget' && <small>{zh ? '选项只读，请在 Grok Bot 中选择。' : 'Read-only options. Choose in Grok Bot.'}</small>}
          <details><summary>{zh ? '消息来源' : 'Message source'}</summary><small>{message.sourceMessageId}{message.sequence != null ? ` · #${message.sequence}` : ''}</small></details>
        </li>)}
      </ol>
    </> : !loading && !unavailable && <p className="grok-conversation__notice" role="status">{zh ? '没有找到已缓存的 Grok 对话。请在本机 Grok Bot 中打开要同步的聊天。办公室不会用任务卡拼造对话。' : 'No cached Grok conversation was found. Open the chat in the local Grok Bot app. Office task cards are never presented as chat messages.'}</p>}
  </section>;
}

export default function GrokConversation({ lang }) {
  const [conversation, setConversation] = useState(EMPTY), [loading, setLoading] = useState(true);
  const state = useRef(EMPTY), current = useRef(null), log = useRef(null), bot = useRef(''), inFlight = useRef(false);
  const refresh = useCallback(async ({ older = false, automatic = false } = {}) => {
    if (automatic && inFlight.current) return;
    current.current?.abort();
    const controller = new AbortController(); current.current = controller; inFlight.current = true; setLoading(true);
    const prior = state.current;
    const params = new URLSearchParams();
    if (bot.current) params.set('botId', bot.current);
    if (older && prior.nextCursor) params.set('cursor', prior.nextCursor);
    const beforeHeight = log.current?.scrollHeight || 0, beforeTop = log.current?.scrollTop || 0;
    const follow = !log.current || beforeHeight - beforeTop - log.current.clientHeight < 60;
    let timedOut = false;
    const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, 8000);
    const active = () => current.current === controller;
    try {
      const response = await fetch(`/api/office/grok/conversation?${params}`, { cache: 'no-store', credentials: 'same-origin', redirect: 'error', signal: controller.signal });
      if (!response.ok) throw new Error('SOURCE_UNAVAILABLE');
      let value = await response.json();
      if (!['empty', 'ready', 'unavailable'].includes(value.phase) || !Array.isArray(value.messages)) throw new Error('INVALID_SOURCE');
      if (!active() || controller.signal.aborted) return;
      if (value.error === 'UNKNOWN_BOT') bot.current = '';
      value = reconcileGrokSnapshot(prior, value, { older, automatic, follow });
      state.current = value; setConversation(value);
      requestAnimationFrame(() => { if (!active() || !log.current) return; if (older) log.current.scrollTop = beforeTop + log.current.scrollHeight - beforeHeight; else if (follow) log.current.scrollTop = log.current.scrollHeight; });
    } catch {
      if (active() && (!controller.signal.aborted || timedOut)) { state.current = { ...EMPTY, phase: 'unavailable', error: 'SOURCE_UNAVAILABLE' }; setConversation(state.current); }
    } finally { clearTimeout(timeout); if (active()) { inFlight.current = false; setLoading(false); } }
  }, []);
  useEffect(() => { void refresh(); const timer = setInterval(() => refresh({ automatic: true }), 15000); return () => { clearInterval(timer); current.current?.abort(); current.current = null; }; }, [refresh]);
  const select = id => { bot.current = id; state.current = EMPTY; setConversation(EMPTY); void refresh(); };
  return <GrokConversationView conversation={conversation} loading={loading} logRef={log} onRefresh={() => refresh()} onOlder={() => refresh({ older: true })} onSelect={select} lang={lang}/>;
}
