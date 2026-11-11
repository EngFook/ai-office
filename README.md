# The AI Office

![The AI Office preview](docs/office-preview.png)

A local, interactive three-floor office dashboard for a Mac. The clickable stacked-building view opens floor 1 (GPT Codex maker studio), floor 2 (Claude Code research atelier), or floor 3 (Grok creative strategy lab). Each floor has its own layout and shared spaces. Each large floor has 200 virtual team members across four departments. Each department has a designated idle room and 50 workstations arranged in modern paired desk pods, with chairs, screens, and circulation aisles. Drag to rotate, right-drag to pan, scroll to zoom, and click a figure to inspect it. Use the directory button to search by number or department; use the expand button for a larger view.

## Start the office

```bash
npm install
npm run dev
```

Open the local address printed in Terminal (normally http://127.0.0.1:5173). Keep Terminal open while using the app. To create a production build, run `npm run build`.

On your Mac, after installing dependencies, you can also double-click `Start AI Office.command` to start the office and open it in your browser.

## Connect AI providers (Floors & AI)

Open **Floors & AI** in the sidebar to manage floors. You can:

- **Add** a floor, pick one of the three floor plans, name its four departments, and choose a colour.
- **Edit** any floor's name, departments and LLM provider: **Google Gemini**, **Anthropic Claude**, or any **OpenAI-compatible** API (OpenAI, xAI Grok via `https://api.x.ai/v1`, OpenRouter, a local Ollama at `http://localhost:11434/v1`, …). Set the model, API key and optional extra instructions, then use **Test connection**.
- **Hide** floors you don't use (at least one stays visible).

Settings and API keys are stored on the computer running the office in `data/floors.json` (gitignored, owner-only permissions). Keys are never sent to the browser. Instead of saving a key in the app, copy `.env.example` to `.env` (also gitignored) and fill in `GEMINI_API_KEY`, `OPENAI_API_KEY` or `ANTHROPIC_API_KEY`; restart the office after editing it.

### Google Gemini

Two ways, both configured in `.env`:

- **AI Studio key** (provider "Google Gemini (AI Studio key)"): set `GEMINI_API_KEY` from https://aistudio.google.com/apikey. Requires billing or prepaid credit on that AI Studio project.
- **Vertex AI** (provider "Google Vertex AI"): Gemini billed to a Google Cloud project, so Cloud credits apply. Set `VERTEX_CREDENTIALS` to a credentials file and `VERTEX_LOCATION=global`. The file can be an `authorized_user` sign-in (for example from `gcloud auth application-default login`, saved at `~/.config/gcloud/application_default_credentials.json`) or a service-account key JSON. Set `VERTEX_PROJECT` if the file does not name a project. The Vertex AI API must be enabled on that project.

Model names are plain Gemini names, for example `gemini-3.8-flash`.

When a floor is connected, a project assigned to it gets a **Run with AI** button (and an optional "start now" box when you create it). The assigned agent sits at their desk while the model works and answers in character for their department. The reply is filed in the file holder as an AI report, and the project is marked Done, or Blocked with the error. The model receives the project name, link and brief only: it cannot open repositories or browse.

To use the office from another device on your network, run `npm run dev:lan` and open the "Network" address it prints. Anyone on that network can then edit floors, spend your API credits and use your Claude Code sign-in (including file edits on floors set to edit), so only do this on a network you trust.

### Claude Code CLI

Provider "Claude Code CLI" runs the `claude` command on the computer hosting the office, using whoever is signed in to Claude Code there (run `claude` once and type `/login`). No API key is needed. Set the model to `sonnet`, `opus` or `fable`.

When a project's path is a local folder under `~/Projects`, Claude works inside that folder. You can change the allowed root with `AI_OFFICE_WORKSPACE_ROOT` in `.env`. Choose per floor whether Claude may only **read** files (the default) or also **edit** them. Shell commands are never allowed. Web search works in both modes.

## Talk to the CEO

Open **Talk to the CEO** and describe a goal in plain words. The CEO runs on a connected floor of your choice and proposes a plan: 1 to 6 tasks, each assigned to a floor and department. Before you approve, you can change a task's floor or department, or remove it. After you approve, each task goes to a free agent in that department, the agents sit down at their desks, and the tasks run in parallel. When all of them finish, the CEO writes a summary. The summary appears in the chat and is saved to the file holder, next to every task's full report.

Tasks run from the browser tab, so keep the page open until they finish. The conversation is stored in the browser.

## What works today

- Explore three large interactive 3D floors with 200 animated, clickable virtual team members per floor. Search the directory to find a specific figure.
- Use **Go to** or click a room label to zoom into a department, idle room, meeting room, reception, or reports hub. Switch between **3D view** and the top-down **Seat map**, and return with **Entire floor**. Camera transitions respect reduced-motion preferences.
- Filter the directory by **At desks** or **Idle rooms**. Open a person and choose **Locate in office** to find their exact position, marked with a ring and name label. Their profile remains available from **View agent**.
- Explore four spacious, labelled departments per floor, plus reception, an enclosed eight-seat meeting room, and a reports and progress area. Select the 3D report or progress signs to open those views.
- Meeting rooms include glass partitions, a shared display, whiteboard, laptops and an eight-seat table. Navigation and agent dialogs also work in fullscreen; use **Exit fullscreen** to return.
- Save project names, GitHub links or local paths, work briefs, and floor-wide or individual assignments. Set progress manually to Planned, In progress, Blocked, or Done.
- Save manual reports in the file holder, optionally linked to a project and individual agent. An individual's detail panel shows their linked work and notes. Assignments and reports are stored in this browser's local storage on this Mac.

Characters are simulated, stylized 3D representations. A person appears at a desk when at least one individual assignment is manually marked In progress; otherwise the person stays in their department’s idle room. Floor-wide assignments do not change individual positions. These positions do not indicate live agent activity. Only floors you connect in **Floors & AI** do real work, and only when you run a project. There is no GitHub access or background activity. Browser data can be cleared by the browser, so keep separate copies of important information.
