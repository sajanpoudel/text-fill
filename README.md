# CheatResume — Browser AI Companion

**A Chrome agent that lives in your browser, learns who you are, and gets things done for you.**

This started as a text-fill tool. It is now a full agentic browser companion. It watches what you do, builds a durable model of who you are, writes in your voice across every site, and can operate the browser autonomously to execute tasks on your behalf — outreach campaigns, profile enrichment, form automation, and more.

The longer you use it, the more capable it becomes.

![Text Fill Demo](public/cheatresume-extension-text-fill.gif)

---

## What It Actually Is

Most AI tools are stateless. You give context, get output, start over. Every session is a blank slate.

This extension is the opposite. It is a persistent intelligence layer running inside your browser that:

- **Observes** every writing session — what you asked for, what the AI produced, what you actually sent
- **Learns** behavioral patterns from those sessions and encodes them as procedural rules
- **Remembers** durable facts about you across three memory tiers
- **Proactively scans** pages for actionable signals and surfaces them as suggestions
- **Executes** multi-step browser tasks autonomously with your approval
- **Writes** in your voice, shaped by full context retrieval, on any text field across 15+ platforms

It is a Chrome companion, not a writing plugin.

---

## Core Capabilities

### Writing — Anywhere, In Your Voice

A floating action button appears next to every supported text field. From it you can:

- **Generate** a fresh response using your full context
- **Rewrite** what is already typed
- **Shorten** or **Expand** text
- Adjust **tone** — casual to formal
- Apply a **domain lens** — general, sales, legal, technical, academic

**Single-click** opens the action menu.
**Double-click** generates instantly.
**Alt+Shift+G** quick-generates on the active focused field.

---

### Agentic Task Execution

The extension includes a full agent runtime for autonomous multi-step browser tasks.

**How it works:**

1. You trigger a task — e.g., "connect with all recruiters on this page"
2. The extension scans the page, identifies candidates, drafts personalized messages using your memory
3. An approval panel shows you the full queue with generated messages before anything is sent
4. You approve, and the agent executes: navigates tabs, fills forms, clicks send, respects daily limits

**What it can do today:**

- Scan LinkedIn search results for candidate profiles (detects 20+ per page)
- Draft personalized connect messages using your memory and the recipient's visible context
- Queue and execute batched outreach with configurable daily limits
- Navigate tabs, extract structured data, click elements, fill fields
- Run multi-step workflows with state machine orchestration

**Human-in-the-loop by design.** The agent always queues tasks for your review before executing. You see the full batch, edit any message, and confirm before the agent touches anything.

---

### Local Companion Runtime

Long-running agentic tasks run through a **local Node.js companion** (`companion/`), not through a cloud service. This companion:

- Runs a WebSocket server on `localhost:4315`
- Connects to Chrome via Chrome DevTools Protocol (MCP)
- Manages run lifecycle, approval state, and action results locally
- Means your browser automation tasks stay on your machine

To start the companion:

```bash
npm run companion:dev
```

The extension automatically connects to it when available. Without the companion, the extension still handles all writing features.

---

### Three-Tier Memory System

**Semantic memory** — durable facts, stored indefinitely, retrieved by vector similarity:
- Work: roles, skills, projects, career direction
- Social: communities, interests, relationships
- Personal: background, values, long-term goals
- Persona: writing identity, only when the signal is strong

**Procedural memory** — behavioral rules learned from repeated session patterns. When you consistently write a certain way in a certain context, the system encodes a rule. Rules gain confidence over time and decay if the pattern disappears.

**Episodic memory** — recent session summaries injected as few-shot examples. The most recent relevant generations, anonymized and condensed, give the model concrete examples of your voice before it writes.

All three tiers are injected as labeled sections into every generation prompt. You get durable facts, behavioral rules, and concrete examples working together.

#### Memory Maintenance

- Weekly cron job handles confidence decay, archival, and cleanup
- **Caps:** 500 active memories, 200 archived
- Memory extraction is conservative — one-off events and stale context stay out
- Bi-temporal validity tracks when facts were true, not just when they were saved

#### Memory Bank UI

The memory page is a full React + Convex interface where you can:

- Browse active and archived memories, filter by category
- Sort by recency, importance, confidence, mentions, last used, forget risk, or semantic similarity
- Run semantic search across saved memories
- Edit, archive, restore, or delete individual entries

---

### Session Observation

The extension watches every compose session and learns from it.

After you close a field, it computes:
- How much you edited the generated text (Levenshtein + trigram diff)
- Whether you actually sent it (three-signal send detection: form submit, Enter/Ctrl+Enter, and mousedown+XHR interception)
- The outcome: accepted, lightly edited, heavily edited, rewritten, abandoned, or sent

This data feeds pattern promotion. When the same platform + context type combination produces a consistent editing pattern across multiple sessions, the system extracts a procedural rule.

---

### Entity Graph

The extension builds and maintains a graph of entities — people, companies, platforms — extracted from your sessions.

- Entities are resolved by lexical match + vector similarity + LLM disambiguation
- Relationships (works\_at, knows, reports\_to) are stored with temporal validity
- The graph is used to surface recipient context during generation (e.g., "you've messaged this person 3 times, you both worked at the same company")

---

### Proactive Scanning

The extension scans pages in the background and surfaces actionable signals.

On LinkedIn search results, it detects candidate profiles, counts connectable targets, and shows a suggestion chip: "20 profiles found — start outreach batch." One click opens the approval queue.

The scanner is extensible. The same architecture supports detecting job listings, recruiter profiles, and other opportunity signals across any page.

---

### Voice Commands

An offscreen document runs continuous Web Speech API recognition. Say the wake word and issue a command:

- "Write a follow-up to Sarah about the contract"
- "Search my memory for Python experience"
- "Connect with all engineers on this page"

The extension parses intent (compose, search, connect) and routes to the right action.

---

### Context Library

Sometimes the context you need is on another page.

The floating Context Library button lets you capture pages and keep them active while writing elsewhere. Toggle multiple contexts on or off per session — job descriptions, company about pages, LinkedIn profiles, reference material.

---

### Platform Awareness

The extension detects where you are and adapts.

First-class platform handling for:

- **Email:** Gmail, Outlook
- **Social / Messaging:** LinkedIn, Messenger, Facebook, Twitter/X, Threads, Instagram, YouTube, Reddit, Discord
- **Work:** Slack, Google Docs
- **Job boards:** Greenhouse, Ashby, Workday, Lever, Canvas
- **Generic:** any text field on the rest of the web

Each platform has custom field detection, page-context extraction, and generation behavior. On job boards and LinkedIn, the system is especially careful not to leak irrelevant memory into high-stakes messages.

---

## Accounts and Settings

Backed by **Convex** with **Convex Auth**.

Sign in with:
- Email + password
- Magic code over email

### Provider Support

Bring your own API keys. Keys are stored on the Convex backend — not in `chrome.storage`.

| Provider | Writing | Memory extraction | Embeddings |
|---|---|---|---|
| **OpenAI** | `gpt-5-nano`, `gpt-5-mini` | `gpt-5-nano` | `text-embedding-3-small`, `text-embedding-3-large` |
| **Anthropic** | `claude-sonnet-4-5`, `claude-haiku-3-5` | `claude-haiku-3-5` | Pair with OpenAI or Gemini for embeddings |
| **Google** | `gemini-3-pro-preview`, `gemini-3-flash-preview` | `gemini-2.5-flash-lite` | `gemini-embedding-001` |

### Settings

- Provider, model, embedding provider/model
- Custom system prompt
- **Career & Work**, **Social & Personal**, and **Always Active** context blocks (paste or upload `.txt`/`.md`)
- Memory caps and pattern confidence (advanced)

---

## Stack

| Layer | Tech |
|---|---|
| Extension build | WXT (Chrome MV3) |
| UI | React 18, Tailwind CSS v4, Radix UI, Lucide |
| Backend | Convex (auth, database, vector search, actions, crons) |
| Agent orchestration | Convex Workflows + local companion |
| Browser control | Chrome DevTools Protocol via MCP |
| Voice | Web Speech API (offscreen document), Porcupine wake word |
| LLM | Vercel AI SDK (`@ai-sdk/openai`) |
| Local companion | Node.js, WebSocket (`ws`), `tsx` |

---

## File Structure

```text
text-fill-v2/
├── entrypoints/
│   ├── background.ts              # Service worker: auth, message routing, task queue
│   ├── content/
│   │   ├── App.tsx                # Main content script: field detection, session lifecycle
│   │   ├── FieldButton.tsx        # Floating button on text fields
│   │   ├── GenerateModal.tsx      # Generation UI (tone, domain, preview, insert)
│   │   ├── ContextFAB.tsx         # Context Library floating button
│   │   ├── AgentFAB.tsx           # Agent task trigger button
│   │   ├── SuggestionChip.tsx     # Proactive scan result chip
│   │   ├── QueuePreviewPanel.tsx  # Batch task approval panel
│   │   └── useAgentCommandRelay.ts # Polls and executes agent browser commands
│   ├── popup/                     # Extension popup (memory stats, recent writings)
│   ├── options/                   # Settings page
│   ├── memory/                    # Memory Bank page
│   └── offscreen/main.ts          # Voice runtime (Web Speech API, wake word)
├── src/
│   ├── lib/
│   │   ├── platform.ts            # Platform detection, field finding, DOM queries
│   │   ├── platforms/             # Per-platform field detection (LinkedIn, Gmail, etc.)
│   │   ├── session-observer.ts    # Compose session lifecycle, diff, send detection
│   │   ├── candidate-scan.ts      # LinkedIn candidate scanning
│   │   ├── scanner.ts             # Opportunity signal detection
│   │   ├── browser-control.ts     # LinkedIn browser automation (state machine)
│   │   ├── browser-executor.ts    # BrowserExecutor interface + Chrome implementation
│   │   ├── browser-command-spec.ts# Serializable browser command types
│   │   ├── browser-observation.ts # Page snapshot types
│   │   ├── local-agent-bridge.ts  # WebSocket bridge to local companion
│   │   ├── local-agent-protocol.ts# Companion protocol types
│   │   ├── agent-planner.ts       # Planner state and decision types
│   │   ├── agent-run-context.ts   # Agent run start context
│   │   ├── agent-panel-runtime.ts # Agent panel state types
│   │   ├── task-queue-storage.ts  # chrome.storage task queue persistence
│   │   ├── task-batch-handoff.ts  # Task batch + Convex sync types
│   │   ├── voice-runtime.ts       # Voice runtime state enum
│   │   ├── captured-contexts.ts   # Context library storage
│   │   ├── context.ts             # Page context extraction orchestrator
│   │   └── dom/                   # ARIA DOM walker, theme detection
│   ├── components/                # Auth screen, shared UI wiring
│   ├── hooks/                     # Convex-backed hooks
│   └── styles/
├── convex/
│   ├── schema.ts                  # All tables: memories, sessions, entities, agent runs
│   ├── auth.ts / auth.config.ts   # Password + magic code auth
│   ├── generate.ts                # Generation action (3-tier retrieval, prompt assembly)
│   ├── memoryExtract.ts           # Memory extraction pipeline
│   ├── memories.ts                # Memory lifecycle, search, maintenance
│   ├── embeddings.ts              # Embedding generation + vector search
│   ├── retrieval.ts               # Episodic + procedural retrieval
│   ├── interactions.ts            # Session recording + pattern promotion trigger
│   ├── patterns.ts                # Procedural pattern promotion and decay
│   ├── entities.ts                # Entity graph lifecycle and resolution
│   ├── agentRuns.ts               # Agent run state machine + browser command routing
│   ├── agentWorkflows.ts          # Long-running agent workflow orchestration
│   ├── taskBatches.ts             # Task batch management
│   ├── voice.ts                   # Voice intent parsing
│   ├── traces.ts                  # Generation trace recording
│   ├── crons.ts                   # Scheduled: pattern decay, memory archival
│   └── llmProvider.ts             # Provider resolution by user config
├── companion/
│   ├── server.ts                  # WebSocket server (localhost:4315)
│   ├── service.ts                 # LocalAgentCompanionService
│   ├── chrome-devtools-mcp-runtime.ts # Chrome DevTools MCP runtime
│   ├── mcp-agent-bridge.ts        # Companion ↔ MCP orchestration bridge
│   ├── state-store.ts             # Local approval + run state persistence
│   └── live-logger.ts             # Companion logging
├── test/                          # Vitest unit + integration tests
├── public/
├── wxt.config.ts
└── package.json
```

---

## Local Development

### 1. Install dependencies

```bash
npm install
```

### 2. Start the Convex backend

```bash
npx convex dev
```

### 3. Create `.env.local`

```bash
VITE_CONVEX_URL=your_convex_deployment_url
```

Set `AUTH_RESEND_KEY` in your Convex environment variables if you want magic-code sign-in.

### 4. Start the extension dev build

```bash
npm run dev
```

### 5. Load the extension in Chrome

Go to `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select:

```text
.output/chrome-mv3-dev
```

### 6. (Optional) Start the local companion

For agentic task execution, start the companion in a separate terminal:

```bash
npm run companion:dev
```

The companion runs on `ws://localhost:4315` and the extension connects automatically.

---

### Production Build

```bash
npm run build
# outputs to .output/chrome-mv3

npm run zip
# creates distributable zip
```

---

### Tests

```bash
npm test
```

Tests cover: session observation, platform detection, candidate scanning, agent run lifecycle, memory retrieval, pattern promotion, entity graph, task batching, companion service, and browser command execution.

---

## Links

- Website: https://www.cheatresume.com/
- Repository: https://github.com/sajanpoudel/text-fill

---

## License

MIT
