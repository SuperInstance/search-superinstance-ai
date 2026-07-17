# search-superinstance-ai

Semantic search over [SuperInstance](https://github.com/SuperInstance) GitHub repos, built on Cloudflare Workers + Vectorize + Workers AI.

A Worker embeds search queries with the `@cf/baai/bge-small-en-v1.5` model (384 dimensions) and queries a Vectorize index populated with repo descriptions. A small dark-themed HTML page at `/` provides a usable search UI.

## Stack

- **Cloudflare Workers** — request handler and embedding client
- **Workers AI** — `@cf/baai/bge-small-en-v1.5` for embeddings
- **Vectorize** — `superinstance-repos` index, cosine similarity
- **No build step** — pure ES module Worker

## Endpoints

| Method | Path             | Purpose                                                |
| ------ | ---------------- | ------------------------------------------------------ |
| GET    | `/`              | Dark-themed search UI                                  |
| GET    | `/health`        | `{ ok: true, model: "..." }`                           |
| GET    | `/api/search?q=` | Embed query, return top-10 matches from Vectorize      |
| POST   | `/api/ingest`    | `{ documents: [{ id, text, metadata }] }` → ingest     |

### `GET /api/search?q=agent+memory&k=10`

```json
{
  "query": "agent memory",
  "model": "@cf/baai/bge-small-en-v1.5",
  "count": 10,
  "results": [
    { "id": "memory-engine", "score": 0.8123, "metadata": { "repo": "memory-engine", "description": "..." } }
  ]
}
```

### `POST /api/ingest`

```bash
curl -X POST https://<your-worker>.workers.dev/api/ingest \
  -H "content-type: application/json" \
  -d '{
    "documents": [
      {
        "id": "memory-engine",
        "text": "Long-form description of the repo used for embedding…",
        "metadata": { "repo": "memory-engine", "description": "Short blurb", "language": "Python", "topic": "memory" }
      }
    ]
  }'
```

The Worker embeds each `text` field in a single batched AI call and inserts into Vectorize in batches of 100. Metadata is stored alongside each vector and returned on query.

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Authenticate wrangler

```bash
npx wrangler login
```

### 3. Create the Vectorize index

```bash
npm run vector:create
# or:
npx wrangler vectorize create superinstance-repos --dimensions=384 --metric=cosine
```

> The bge-small model produces **384-dimensional** vectors — make sure the index dimensions match.

### 4. Local development

```bash
npm run dev
# → http://localhost:8787
```

The local dev server picks up the `AI` and `VECTOR_INDEX` bindings from `wrangler.toml`. (For `AI` you'll be authenticated against your Cloudflare account; `VECTOR_INDEX` may need `--remote` for live data.)

### 5. Deploy

```bash
npm run deploy
```

The first deploy will provision the Worker and bind it to your existing `superinstance-repos` Vectorize index.

### 6. Ingest repo data

Either POST to `/api/ingest` directly (see example above) or write a small ingest script that fetches repos from the GitHub API and pipes them into the endpoint. A single document looks like:

```json
{
  "id": "memory-engine",
  "text": "<README + description — used for the embedding>",
  "metadata": {
    "repo": "memory-engine",
    "description": "Short user-facing blurb",
    "language": "Python",
    "topic": "agents",
    "url": "https://github.com/SuperInstance/memory-engine"
  }
}
```

The UI displays `metadata.repo` (or `metadata.name` / `id`) as the link target, `metadata.description` as the blurb, and renders any of `language`, `topic`, `category`, `type` as tags.

## File layout

```
search-superinstance-ai/
├── package.json
├── README.md
├── wrangler.toml
└── src/
    ├── index.js      # Worker (routes, embedding helpers, Vectorize calls)
    └── index.html    # Dark-themed search UI (imported as a text module)
```

## Free-tier notes

- **Workers AI free tier:** 10,000 neurons/day — bge-small-en-v1.5 uses ~25 M-NEURONs per 1k input tokens, so ~400k tokens/day of free embedding capacity.
- **Vectorize free tier:** 30M stored vectors, 50M queried vectors/month — more than enough for ~hundreds of repos.
- **Workers free tier:** 100k requests/day.

For typical SuperInstance-scale workloads (tens of repos, low query volume), this stays comfortably inside the free tier.

## Tweaks

- **topK** — default 10, clamp 1–50 via `?k=N` on `/api/search`.
- **Model** — change `EMBED_MODEL` in `src/index.js`. If you swap to a 768-dim model, recreate the Vectorize index with `--dimensions=768`.
- **CORS** — `*` by default; tighten `corsHeaders()` in `src/index.js` if you front the API from a custom domain.
