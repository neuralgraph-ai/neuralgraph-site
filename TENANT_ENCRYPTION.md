# Tenant-Level Encryption Strategy

## Overview

All content stored in the SQL layer is encrypted per-tenant. The graph structure (edges, scores, timestamps) and vector embeddings remain unencrypted so the server can perform structural operations without access to content. The tenant sends their decryption key with each API request. Without an active request carrying the key, content is unreadable to anyone — operators, DBAs, background jobs, or breach actors.

## Architecture

```
Encrypted (SQL):
  - Topic names, summaries, entities
  - Anchor text
  - User/AI profile content
  - Any human-readable payload

Unencrypted:
  - Graph edges, trigger strengths, connection scores
  - Vector embeddings
  - IDs, tenant_id, user_id
  - Timestamps (created_at, updated_at, deleted_at)
  - Importance scores
  - Job metadata
```

## Request Flow

```
Client request:
  Authorization: Bearer <token>
  X-Encryption-Key: <tenant-key>

Server:
  1. Verify auth, resolve tenant
  2. Decrypt topic payloads in memory using the key
  3. Build system prompt, run hydration, etc.
  4. Encrypt any new/updated payloads before writing to SQL
  5. Return response
  6. Key falls out of scope
```

## SQL Schema (encrypted model)

```sql
topics:
  id          UUID        -- plaintext
  tenant_id   TEXT        -- plaintext (routing)
  user_id     TEXT        -- plaintext (RLS)
  payload     BYTEA       -- encrypted (name, summary, entities, anchors, all content)
  created_at  TIMESTAMP   -- plaintext
  updated_at  TIMESTAMP   -- plaintext
  importance  FLOAT       -- plaintext (server needs for scoring)
  deleted_at  TIMESTAMP   -- plaintext
```

The `payload` column is an encrypted blob containing everything a human would read. Structural fields the server needs for scoring, lifecycle, and routing stay plaintext and queryable.

## Key Management

The tenant key is derived from the user's password at login time using PBKDF2:

```
key = PBKDF2(password, tenant_salt, iterations=600000, keylen=32, hash=SHA-256)
```

- The key is never stored on the server
- The key lives in browser memory (JS variable) for the duration of the session
- Sent with every API request via `X-Encryption-Key` header
- Password change requires re-encryption of all tenant data (migration runs while old key is still in memory)

## Key Safety Rules

- **Never log the key.** Strip `X-Encryption-Key` from all request logging middleware before serialization.
- **Never include in error payloads.** Error responses must not echo request headers.
- **Never store in a cache, context, or struct that outlives the request.**
- **Zero the key bytes after use.** In Go: `for i := range key { key[i] = 0 }`. Best-effort (GC may have copied), but reduces the window.
- **TLS only.** Key is in a header, encrypted in transit via HTTPS.

## Background Jobs

Jobs run without a tenant request and therefore without a decryption key. They operate purely on unencrypted structural data.

### Jobs that work without content

| Job | What it uses |
|---|---|
| Edge/trigger strength decay | Scores + timestamps |
| Orphan node detection | Graph topology |
| Vector deduplication flagging | Vector cosine similarity |
| Importance score decay | Float score + timestamps |
| Connection inference (A→B, B→C → suggest A→C) | Graph edges |
| Cluster detection | Vector distances |

### Jobs that need content (deferred)

| Job | Why it needs content |
|---|---|
| Topic merge execution | Must read + rewrite summaries |
| Topic re-extraction | Must re-run LLM on content |
| Anchor text regeneration | Must read topic to generate anchors |

These are queued as **pending actions**. They execute opportunistically the next time the tenant makes a request and sends their key:

```
1. Tenant sends request with key
2. Server handles the primary request
3. Server checks pending_actions for this tenant
4. Processes deferred jobs while key is in memory
5. Writes encrypted results back, clears the queue
```

Latency for deferred jobs = time until the tenant's next API call.

## Vector Embedding Privacy Note

Embeddings are unencrypted by design. They don't contain plaintext but do leak semantic similarity — an attacker with vector access could cluster topics and infer broad categories (e.g. "this cluster is near medical content"). This is an accepted trade-off. Mitigations if needed later:

- Add calibrated noise to stored vectors (degrades search quality slightly)
- Binary quantization (lossy, harder to reverse)
- For most threat models, knowing topic categories is not the sensitive part — the actual content is

## Implementation Order

1. Add `payload BYTEA` column, migrate existing plaintext fields into encrypted blobs
2. Add encryption/decryption helpers in the API layer (AES-256-GCM)
3. Add `X-Encryption-Key` header handling + middleware to strip from logs
4. Add `pending_actions` table for deferred jobs
5. Update ingest/hydrate/extract to encrypt on write, decrypt on read
6. Update background job framework to queue content-dependent work
7. Add opportunistic job processing to the request lifecycle
8. Key derivation on the client (PBKDF2 from password at login)
