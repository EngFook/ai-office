import { GROK_COMMUNICATION_POLICY } from './communication-policy.mjs';

export const OFFICE_PROJECT_POLICY = `Office project ownership rule: only the user decides to add an AI Office project. Never create or register an Office project, edit project-catalog.json, or call a project-registration endpoint unless the user explicitly authorizes that exact catalog change. A task card, folder, repository, worktree, native session or sub-agent is not authorization to add a project. You may use directories and worktrees already authorized for the assigned task without registering them as Office projects. Do not infer project authorization from automatic task discovery, delegation or suggested plans. Preserve user-managed project entries and pass this rule to delegated agents. Never manufacture a user request or approval.`;

export const OFFICE_AGENT_POLICY = `${GROK_COMMUNICATION_POLICY}\n\n${OFFICE_PROJECT_POLICY}`;
