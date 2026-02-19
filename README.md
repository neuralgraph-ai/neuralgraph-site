# neuralgraph.app

Landing page and sandbox for [NeuralGraph](https://neuralgraph.app) — a context engine for AI.

## Structure

- **Landing page** (`/`) — static marketing page
- **Sandbox** (`/sandbox`) — invite-only chat interface demonstrating NeuralGraph's end-to-end flow (ingest, hydrate, LLM response)
- **API proxy** (`/api/*`) — Cloud Function that validates Firebase Auth tokens and proxies requests to the NeuralGraph API

Hosted on Firebase Hosting with Cloud Functions.

## Setup

See [SETUP.md](SETUP.md) for deployment instructions.
