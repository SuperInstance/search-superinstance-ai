// search-superinstance — Cloudflare Worker
// Semantic search over SuperInstance GitHub repos using
// Workers AI (bge-small-en-v1.5, 384 dims) + Vectorize.

import indexHtml from './index.html';

const EMBED_MODEL = '@cf/baai/bge-small-en-v1.5';
const EMBED_DIMS = 384;
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
	if (url.pathname === '/api/stats' && request.method === 'GET') return handleStats(env);
	if (url.pathname === '/api/search' && request.method === 'GET') return handleSearch(url, env);
	if (url.pathname === '/api/ingest' && request.method === 'POST') return handleIngest(request, env);

	return new Response('Not Found', { status: 404, headers: corsHeaders() });
}

function serveIndex() {
	return new Response(indexHtml, {
		headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' },
	});
}

async function handleStats(env) {
	try {
		// Vectorize caps topK at 100, so we can't get the full total from a
		// query alone. Use the query as a liveness check and report the known
		// total (4147) so the demo shows the real number.
		const dummy = new Array(EMBED_DIMS).fill(0);
		const result = await env.VECTOR_INDEX.query(dummy, {
			topK: 100,
			returnMetadata: 'none',
			returnValues: false,
		});
		const live = typeof result.count === 'number' && result.count > 0;
		return json({
			repos: 4147,
			index: 'superinstance-repos',
			model: EMBED_MODEL,
			live,
			queryMatches: result.count ?? 0,
		});
	} catch (err) {
		return json({ error: err.message || String(err), model: EMBED_MODEL }, 500);
	}
}

async function handleSearch(url, env) {
	const q = (url.searchParams.get('q') || '').trim();
	if (!q) return json({ error: 'Missing query parameter "q".' }, 400);

	const topK = clampInt(url.searchParams.get('k'), 1, 50, 10);
	const lang = (url.searchParams.get('lang') || '').trim();

	try {
		const embedOut = await env.AI.run(EMBED_MODEL, { text: [q] });
		const queryVector = Array.from(embedOut.data[0]);

		// If a language filter is set, over-fetch so we still get a useful
		// number of matches after filtering. Vectorize metadata filters need
		// properties to be explicitly indexed at insert time, so we filter
		// client-side (in the Worker) instead.
		const fetchK = lang ? Math.min(100, topK * 5) : topK;
		const result = await env.VECTOR_INDEX.query(queryVector, {
			topK: fetchK,
			returnMetadata: 'all',
			returnValues: false,
		});

		let matches = (result.matches || []).map((m) => ({
			id: m.id,
			score: m.score,
			metadata: m.metadata || {},
		}));

		if (lang) {
			const before = matches.length;
			matches = matches.filter((m) => m.metadata?.language === lang);
		}
		matches = matches.slice(0, topK);

		// Compute top languages across the unfiltered, topK-sized result set
		// for filter chips.
		const unfiltered = (result.matches || []).slice(0, topK);
		const langCounts = new Map();
		for (const m of unfiltered) {
			const l = m.metadata?.language;
			if (!l) continue;
			langCounts.set(l, (langCounts.get(l) || 0) + 1);
		}
		const topLanguages = [...langCounts.entries()]
			.sort((a, b) => b[1] - a[1])
			.slice(0, 6)
			.map(([language, count]) => ({ language, count }));

		return json({
			query: q,
			model: EMBED_MODEL,
			filter: lang || null,
			count: matches.length,
			topLanguages,
			results: matches,
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
