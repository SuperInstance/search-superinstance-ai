// search-superinstance — Cloudflare Worker
// Semantic search over SuperInstance GitHub repos using
// Workers AI (bge-small-en-v1.5, 384 dims) + Vectorize.

import indexHtml from './index.html';

const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
const VECTORIZE_BATCH = 100;

export default {
	async fetch(request, env) {
		return handleRequest(request, env);
	},
};

async function handleRequest(request, env) {
	const url = new URL(request.url);

	if (request.method === 'OPTIONS') {
		return new Response(null, { headers: corsHeaders() });
	}

	if (url.pathname === '/' && request.method === 'GET') return serveIndex();
	if (url.pathname === '/health' && request.method === 'GET') return json({ ok: true, model: EMBED_MODEL });
	if (url.pathname === '/api/search' && request.method === 'GET') return handleSearch(url, env);
	if (url.pathname === '/api/ingest' && request.method === 'POST') return handleIngest(request, env);

	return new Response('Not Found', { status: 404, headers: corsHeaders() });
}

function serveIndex() {
	return new Response(indexHtml, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
	});
}

async function handleSearch(url, env) {
	const q = (url.searchParams.get('q') || '').trim();
	if (!q) return json({ error: 'Missing query parameter "q".' }, 400);

	const topK = clampInt(url.searchParams.get('k'), 1, 50, 10);

	try {
		const embedOut = await env.AI.run(EMBED_MODEL, { text: [q] });
		const queryVector = Array.from(embedOut.data[0]);

		const result = await env.VECTOR_INDEX.query(queryVector, {
			topK,
			returnMetadata: 'all',
			returnValues: false,
		});

		return json({
			query: q,
			model: EMBED_MODEL,
			count: (result.matches || []).length,
			results: (result.matches || []).map((m) => ({
				id: m.id,
				score: m.score,
				metadata: m.metadata || {},
			})),
		});
	} catch (err) {
		return json({ error: err.message || String(err) }, 500);
	}
}

async function handleIngest(request, env) {
	let body;
	try { body = await request.json(); } catch { return json({ error: 'Invalid JSON.' }, 400); }

	const docs = body?.documents;
	if (!Array.isArray(docs) || docs.length === 0) return json({ error: 'Body needs "documents" array.' }, 400);

	const cleaned = [];
	for (let i = 0; i < docs.length; i++) {
		const d = docs[i];
		if (!d?.id || !d?.text?.trim()) return json({ error: `documents[${i}] needs "id" and "text".` }, 400);
		cleaned.push({ id: d.id, text: d.text, metadata: d.metadata || {} });
	}

	try {
		const out = await env.AI.run(EMBED_MODEL, { text: cleaned.map((d) => d.text) });
		const vectors = out.data.map((v) => Array.from(v));

		const records = cleaned.map((d, i) => ({ id: d.id, values: vectors[i], metadata: d.metadata }));

		let inserted = 0;
		for (let i = 0; i < records.length; i += VECTORIZE_BATCH) {
			await env.VECTOR_INDEX.insert(records.slice(i, i + VECTORIZE_BATCH));
			inserted += Math.min(VECTORIZE_BATCH, records.length - i);
		}

		return json({ ingested: inserted, model: EMBED_MODEL });
	} catch (err) {
		return json({ error: err.message || String(err) }, 500);
	}
}

function json(payload, status = 200) {
	return new Response(JSON.stringify(payload), {
		status,
		headers: { 'content-type': 'application/json; charset=utf-8', ...corsHeaders() },
	});
}

function corsHeaders() {
	return {
		'access-control-allow-origin': '*',
		'access-control-allow-methods': 'GET, POST, OPTIONS',
		'access-control-allow-headers': 'content-type',
		'access-control-max-age': '86400',
	};
}

function clampInt(raw, lo, hi, fallback) {
	const n = parseInt(raw, 10);
	return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : fallback;
}
