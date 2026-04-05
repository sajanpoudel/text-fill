# Text Fill

**Your browser companion that learns who you are and helps you write, everywhere.**

Text Fill lives in your browser and watches your back. It learns your voice, remembers what matters to you, and helps you write better responses across every site you use: emails, job applications, LinkedIn messages, tweets, comments, documents, forms, and more.

The longer you use it, the better it knows you.

The current extension ships in Chrome as **CheatResume - Text Fill**, but the core idea is still the same: one writing layer that follows you across the web and gets sharper over time.

![Text Fill Demo](public/cheatresume-extension-text-fill.gif)

---

## What It Does

Most writing tools make you repeat yourself. You paste your resume every time, re-explain your background, switch tabs for context, and keep re-teaching the model who you are.

Text Fill does the opposite.

It drops a floating action button next to supported text fields across the web. From there you can:

- **Generate** a fresh response
- **Rewrite** what is already in the field
- **Shorten** it
- **Expand** it
- Adjust **tone** from casual to formal
- Apply a **domain lens** like general, sales, legal, technical, or academic

**Single-click** opens the action menu.  
**Double-click** generates instantly.  
**Alt+Shift+G** quick-generates on the active field.

The system uses the page you are on, the field you are writing in, your saved personal context, and your memory bank to produce something that sounds like it came from you, not from a generic assistant.

---

## Memory - The Core

Text Fill learns from your usage over time. After longer generations, it can extract durable facts worth remembering and store them as memory:

- **Work**: roles, skills, projects, career direction, durable professional facts
- **Social**: communities, recurring interests, relationship context that actually matters
- **Personal**: stable background, preferences, values, long-term goals
- **Persona**: your writing identity, but only when the signal is unusually strong

Memory is conservative by design. It tries to save durable truths, not temporary noise. One-off outreach attempts, old application events, and other fragile context are supposed to stay out of the long-term memory bank.

### Semantic Search

When embeddings are configured, Text Fill uses vector search in Convex to surface the memories most relevant to the exact writing situation in front of you. It is not just keyword matching. The memory system tries to find the facts that actually fit the context.

OpenAI and Gemini can be used for embeddings. Anthropic works for writing, but it still needs OpenAI or Gemini alongside it if you want semantic memory retrieval.

### Forgetting Curve

Memories are not meant to live forever unchanged. The current system tracks reinforcement, last access, importance, confidence, and forget risk. A weekly maintenance job handles archiving and cleanup so the memory bank stays useful instead of turning into a pile of stale facts.

**Caps:** 500 active memories, 200 archived.

### Memory Bank

The memory page is now a full React + Convex interface where you can:

- Browse active and archived memories
- Filter by category
- Sort by recency, importance, confidence, mentions, last used, forget risk, or semantic match
- Run semantic search across saved memories
- Edit, archive, restore, or delete entries

---

## Context Library

Sometimes the context you need is on another page entirely.

The floating **Context Library** button lets you capture pages and keep them active while you write somewhere else. You can add multiple pages, toggle them on or off, and include them in the next generation run without copying anything manually.

This is useful for things like:

- job descriptions
- company about pages
- LinkedIn profiles
- assignment prompts
- reference material you want the model to actually use

---

## Platform Awareness

Text Fill detects where you are writing and changes how it behaves.

The current codebase includes first-class handling for:

- Gmail and Outlook
- LinkedIn
- Messenger and Facebook
- Twitter/X, Threads, Instagram, YouTube, and Reddit
- Slack and Discord
- Google Docs
- Canvas
- Greenhouse, Ashby, Workday, and Lever
- generic text fields on the rest of the web

It also includes platform-specific field detection and page-context extraction so the generated text is shaped by the environment you are actually in, not by a one-size-fits-all prompt.

On job boards and LinkedIn, the system is especially opinionated about using the visible foreground context correctly and not leaking irrelevant memory into high-stakes messages.

---

## Accounts, Providers, and Settings

The new version is backed by **Convex** and uses **Convex Auth** instead of a purely local extension state model.

You can sign in with:

- email + password
- magic code over email

Bring your own model keys in Settings. The current UI supports:

| Provider | Writing models | Memory / extraction models | Embeddings |
|----------|----------------|----------------------------|------------|
| **OpenAI** | `gpt-5-nano`, `gpt-5-mini` | `gpt-5-nano` | `text-embedding-3-small`, `text-embedding-3-large` |
| **Anthropic** | `claude-sonnet-4-5`, `claude-haiku-3-5` | `claude-haiku-3-5` | Use OpenAI or Gemini for embeddings |
| **Google** | `gemini-3-pro-preview`, `gemini-3-flash-preview` | `gemini-2.5-flash-lite`, `gemini-3-flash-preview` | `gemini-embedding-001` |

Your saved settings include:

- provider and model selection
- memory model selection
- embedding provider/model selection
- custom system prompt
- **Career & Work**, **Social & Personal**, and **Always Active** context blocks

You can paste context directly or upload a text/Markdown file. The current uploader is built for text-based files, not PDF parsing.

API keys are stored in the user profile on the Convex backend, not in `chrome.storage`.

---

## Stack

This is no longer the old single-file Chrome extension layout.

The current app is built with:

- **WXT** for the Chrome MV3 extension build/runtime
- **React 18** for popup, options, memory bank, and injected UI
- **Convex** for auth, persistence, actions, vector search, and scheduled maintenance
- **Tailwind CSS v4** for the larger app surfaces
- **Radix UI** and **Lucide** for UI primitives/icons

The background service worker is now a thin bridge between the extension runtime and Convex actions. Most of the real logic lives in the backend modules under `convex/`.

---

## File Structure

```text
text-fill-v2/
├── entrypoints/
│   ├── background.ts          # Service worker: generation bridge, auth refresh, alarms
│   ├── content/               # Injected field button, modal, context library, DOM UI
│   ├── popup/                 # Popup dashboard
│   ├── options/               # Settings page
│   └── memory/                # Memory Bank page
├── src/
│   ├── components/            # Auth screen, providers, shared UI wiring
│   ├── hooks/                 # Convex-backed hooks for memories, user, generation
│   ├── lib/                   # Platform detection, DOM walking, context extraction, insertion
│   └── styles/                # Global styles
├── convex/
│   ├── schema.ts              # Tables for profiles, memories, embeddings, auth
│   ├── auth.ts                # Password + magic-code auth
│   ├── generate.ts            # Main generation / rewrite / shorten / expand actions
│   ├── memoryExtract.ts       # Durable memory extraction pipeline
│   ├── memories.ts            # Memory lifecycle, dedupe, search, maintenance
│   ├── embeddings.ts          # Embedding generation and vector search
│   └── context.ts             # Captured context persistence helpers
├── public/
│   ├── logo.png
│   └── cheatresume-extension-text-fill.gif
├── wxt.config.ts              # Extension manifest + build config
└── package.json
```

---

## Local Development

1. Install dependencies:

   ```bash
   npm install
   ```

2. Start or connect your Convex backend:

   ```bash
   npx convex dev
   ```

3. Create `.env.local` with your client URL:

   ```bash
   VITE_CONVEX_URL=your_convex_deployment_url
   ```

4. Configure any needed Convex environment variables for auth and email delivery.
   `AUTH_RESEND_KEY` is required if you want magic-code sign-in.

5. Start the extension dev build:

   ```bash
   npm run dev
   ```

6. Open `chrome://extensions`, enable **Developer mode**, click **Load unpacked**, and select:

   ```text
   .output/chrome-mv3-dev
   ```

When you want a production build:

```bash
npm run build
```

That outputs the unpacked extension to:

```text
.output/chrome-mv3
```

To create a distributable zip:

```bash
npm run zip
```

---

## Links

- Website: https://www.cheatresume.com/
- Repository: https://github.com/sajanpoudel/text-fill

---

## License

MIT
