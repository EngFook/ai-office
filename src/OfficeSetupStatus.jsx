import React from 'react';
import './office-setup-status.css';

export default function OfficeSetupStatus({ configuration, lang = 'en', runtime = {}, autoPickup = false, onTasks }) {
  if (!configuration) return null;
  const needsSetup = !configuration.configured;
  const readOnly = configuration.mode === 'read-only';
  const paused = configuration.mode === 'disabled';
  const zh = lang === 'zh';
  const enabled = (configuration.providers || []).filter(provider => provider.enabled);
  const ready = enabled.filter(provider => runtime.providers?.[provider.id]?.available && runtime.providers?.[provider.id]?.authenticated === true);
  const setupCommand = `npm run setup${needsSetup ? (zh ? '' : ' -- --lang en') : ` -- --overwrite${zh ? '' : ' --lang en'}`}`;
  const title = needsSetup
    ? (zh ? '先设置你的办公室' : 'Set up your office')
    : readOnly ? (zh ? '只读模式' : 'Read-only mode')
      : paused ? (zh ? '自动执行已关闭' : 'Execution is disabled') : (zh ? '使用指南与连接状态' : 'Getting started & connections');
  return <section className="office-setup-status" data-no-i18n>
    {(needsSetup || readOnly || paused) && <div className="office-setup-intro" role="status">
    <div><strong>{title}</strong><p>{needsSetup
      ? (zh ? '在运行办公室的电脑上，进入项目目录运行设置向导，选择工作区和 AI。新安装不会自动接单。' : 'On the computer running this office, run setup from the project directory to choose your workspace and AI providers. New installations do not pick up tasks automatically.')
      : (zh ? '当前不会启动 AI 执行任务。请在运行办公室的电脑上使用设置向导调整运行模式。' : 'AI task execution is paused. Use setup on the computer running this office to change the operating mode.')}</p>
      <p>{zh ? 'Claude / Codex 使用各自 CLI 的订阅登录；账号与密钥只在本机配置。' : 'Claude / Codex use their own CLI subscription login; accounts and credentials are configured locally.'}</p>
    </div>
    <code aria-label={zh ? '本机设置命令' : 'Local setup command'}>{setupCommand}</code>
    </div>}
    <details className="office-start-guide" open={needsSetup}>
      <summary>{zh ? '开始使用 · 三步完成第一项任务' : 'Getting started · Your first task in three steps'}<span>{zh ? `${enabled.length} 个已启用 · ${ready.length} 个已就绪` : `${enabled.length} enabled · ${ready.length} ready`}</span></summary>
      <ol>
        <li><strong>{zh ? '1. 选择自己的项目与 AI' : '1. Choose your project and AI'}</strong><p>{zh ? '在本机终端进入项目目录，运行设置向导。选择现有工作目录、需要的 AI 和 enabled 模式；不需要接入所有 AI。' : 'From the project folder in your terminal, run setup. Select an existing workspace, the AI providers you need, and enabled mode. You do not need every provider.'}</p><code>{setupCommand}</code><p>{zh ? '保存后重启办公室：Ctrl+C，然后 npm start。' : 'After saving, restart the office: Ctrl+C, then npm start.'}</p></li>
        <li><strong>{zh ? '2. 检查连接' : '2. Check connections'}</strong><p>{zh ? '使用各自 CLI 登录 Claude/Codex；显示“已安装”不等于“已登录”。Claude 人物观察还需运行 npm run connect:claude 并重启 Claude 会话。' : 'Sign in through each provider CLI. Installed does not mean signed in. For Claude figures, also run npm run connect:claude and restart Claude sessions.'}</p><code>npm run doctor</code><p>{zh ? '本地模型：先启动 Ollama，并选择 ollama list 中已有的模型。Grok Bot 的连接说明在“调度”页。' : 'Local models: start Ollama and select a model shown by ollama list. Grok Bot setup is on the Dispatch page.'}</p>{enabled.length > 0 && <ul>{enabled.map(provider => <li key={provider.id}>{provider.id}: {ready.some(item=>item.id===provider.id) ? (zh ? '已就绪' : 'Ready') : (zh ? '待验证，请查看任务板连接原因' : 'Check readiness on the task board')}</li>)}</ul>}</li>
        <li><strong>{zh ? '3. 添加一个小任务' : '3. Add a small task'}</strong><p>{zh ? '例如“检查 README 的错别字”。选择项目目录和执行者，再打开任务板的“自动接单”。卡片会显示等待原因、执行结果，以及需要你回复或批准的问题。' : 'Try “Check the README for typos.” Select its project folder and provider, then enable Auto pickup on the task board. Cards show wait reasons, results, and questions needing your reply or approval.'}</p><p>{zh ? `自动接单：${autoPickup ? '已开启' : '已关闭'}。代码任务还需要已启用、已登录的独立审查员。` : `Auto pickup: ${autoPickup ? 'on' : 'off'}. Code tasks also need an enabled, signed-in independent reviewer.`}</p>{onTasks && <button type="button" onClick={onTasks}>{zh ? '打开任务板' : 'Open task board'} →</button>}</li>
      </ol>
      <details className="office-help"><summary>{zh ? '看不到人物、任务不动或手机打不开？' : 'Empty office, stalled task or phone cannot connect?'}</summary><p>{zh ? '办公室空着：只有真实运行并上报活动的代理才出现。任务不动：查看卡片等待原因，依次检查自动接单、登录、额度、审查员和项目目录。受阻任务需要按卡片提示处理后重新请求。' : 'Empty office: only real agents reporting activity appear. Stalled task: check the card’s wait reason, Auto pickup, login, quota, reviewer and project folder. Resolve the blocker before retrying.'}</p><p>{zh ? '手机上的 127.0.0.1 指向手机，不是电脑。请按安装指南启用并配对手机入口。电脑上的终端关闭后，办公室也会停止。' : '127.0.0.1 on a phone points to the phone. Use the paired mobile gateway described in the installation guide. Closing the server terminal stops the office.'}</p></details>
    </details>
  </section>;
}
