# Diagram Studio

A local web app that turns a concept into an editable diagram using LLMs and image models.

## How it works

1. **Clarify**: the agent analyses the topic from first principles and asks a few questions.
2. **Concept**: it proposes a concept and mechanism you can revise and approve.
3. **Composition**: it proposes layouts and draws a quick draft of each.
4. **Images**: it generates candidate images for the chosen composition.
5. **Components**: the picked image is split into components (icons, labels, connectors) and traced to SVG.
6. **Workspace**: an editable canvas with recolourable vector nodes, text and edges.

Projects are stored on disk under `data/projects/`.

## Quick start

Requires Node 20+ and pnpm.

```bash
pnpm install
pnpm dev
```

Open the web app at http://localhost:5174 (the API runs on http://localhost:8790). Click **API keys** in the top bar and add a key, or run without one in offline mock mode, which uses placeholder content.

## API keys (bring your own)

Click **API keys** in the top bar and paste a key:

| Provider | Covers |
| --- | --- |
| OpenRouter (recommended) | text and image models with one key |
| Anthropic | text models |
| Gemini | text and image models |
| OpenAI | image models |

Each row has **Test key** (a cheap read-only call to the provider) and **Remove**.

- Keys are stored in your browser's `localStorage` only, never in project files.
- The web app sends them to the server as request headers (`X-OpenRouter-Key`, `X-Anthropic-Key`, `X-Gemini-Key`, `X-OpenAI-Key`). Query strings are not accepted.
- The server scopes keys to the request, and to any background job that request starts. They are not written to `project.json`, usage or log files, and are scrubbed from error messages.
- A key from the browser takes precedence over the server's environment. If you supply keys, the provider is picked from them (OpenRouter, then Anthropic/OpenAI/Gemini) and env model overrides for a different provider are ignored.
- Anyone who can reach your server can see the headers of their own requests only; run the server on localhost, or behind HTTPS if you expose it.

### Environment keys (local single-user use)

Keys in `.env` still work as a fallback when the browser sends none:

```bash
cp .env.example .env   # then fill in a key; the file is git-ignored
```

`.env.example` contains placeholders only. It also lists optional provider and model overrides.

## Development

```bash
pnpm --filter ./apps/server exec vitest run   # server tests
pnpm -r exec tsc --noEmit                     # typecheck
```

Layout: `apps/server` (Hono API and pipeline), `apps/web` (React + Vite), `packages/core` (shared zod schemas).

## Licence

MIT. See [LICENSE](LICENSE).
