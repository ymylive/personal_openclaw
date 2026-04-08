/**
 * Tests for EmbeddingUtils.js
 *
 * Strategy: cosineSimilarity is tested as a pure function.
 * getEmbeddingsBatch is tested using a local HTTP server that simulates
 * the embedding API, since node-fetch v3 (ESM-only) uses dynamic import()
 * which cannot be intercepted by jest.mock in CJS mode.
 */

const http = require('http');

// Mock tiktoken to avoid native dependency issues in test
jest.mock('@dqbd/tiktoken', () => ({
    get_encoding: () => ({
        encode: (text) => new Array(text.length) // 1 token per char
    })
}));

const { getEmbeddingsBatch, cosineSimilarity } = require('../EmbeddingUtils');

// --- Local mock API server ---
let server;
let serverPort;
let requestLog = [];
let responseQueue = [];

function enqueueResponse(statusCode, body) {
    responseQueue.push({ statusCode, body });
}

beforeAll((done) => {
    server = http.createServer((req, res) => {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            requestLog.push({ method: req.method, url: req.url, body: JSON.parse(body) });
            const resp = responseQueue.shift();
            if (resp) {
                res.writeHead(resp.statusCode, { 'Content-Type': 'application/json' });
                res.end(typeof resp.body === 'string' ? resp.body : JSON.stringify(resp.body));
            } else {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'No response queued' }));
            }
        });
    });
    server.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        done();
    });
});

afterAll((done) => {
    server.close(done);
});

beforeEach(() => {
    requestLog = [];
    responseQueue = [];
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

function getConfig() {
    return {
        apiUrl: `http://127.0.0.1:${serverPort}`,
        model: 'text-embedding-test',
        apiKey: 'test-key-123'
    };
}

function makeEmbeddingResponse(embeddings) {
    return {
        data: embeddings.map((emb, i) => ({ index: i, embedding: emb }))
    };
}

// ===== cosineSimilarity tests =====
describe('cosineSimilarity', () => {
    test('returns correct similarity for identical vectors', () => {
        const v = [1, 0, 0];
        expect(cosineSimilarity(v, v)).toBeCloseTo(1.0, 4);
    });

    test('returns ~0 for orthogonal vectors', () => {
        const a = [1, 0, 0];
        const b = [0, 1, 0];
        expect(cosineSimilarity(a, b)).toBeCloseTo(0, 4);
    });

    test('returns 0 for null/undefined inputs', () => {
        expect(cosineSimilarity(null, [1, 2])).toBe(0);
        expect(cosineSimilarity([1, 2], null)).toBe(0);
        expect(cosineSimilarity(undefined, undefined)).toBe(0);
    });

    test('returns 0 for mismatched length vectors', () => {
        expect(cosineSimilarity([1, 2], [1, 2, 3])).toBe(0);
    });

    test('computes correct value for known vectors', () => {
        const a = [1, 2, 3];
        const b = [4, 5, 6];
        // cos(a,b) = 32 / (sqrt(14) * sqrt(77)) ~= 0.9746
        expect(cosineSimilarity(a, b)).toBeCloseTo(0.9746, 3);
    });
});

// ===== getEmbeddingsBatch tests =====
describe('getEmbeddingsBatch', () => {
    test('returns empty array for empty input', async () => {
        const result = await getEmbeddingsBatch([], getConfig());
        expect(result).toEqual([]);
    });

    test('returns empty array for null input', async () => {
        const result = await getEmbeddingsBatch(null, getConfig());
        expect(result).toEqual([]);
    });

    test('processes a small batch and returns correct embeddings', async () => {
        const texts = ['hello', 'world'];
        const embeddings = [[0.1, 0.2, 0.3], [0.4, 0.5, 0.6]];

        enqueueResponse(200, makeEmbeddingResponse(embeddings));

        const result = await getEmbeddingsBatch(texts, getConfig());

        expect(result).toHaveLength(2);
        expect(result[0]).toEqual([0.1, 0.2, 0.3]);
        expect(result[1]).toEqual([0.4, 0.5, 0.6]);

        // Verify the request was correct
        expect(requestLog).toHaveLength(1);
        expect(requestLog[0].body.model).toBe('text-embedding-test');
        expect(requestLog[0].body.input).toEqual(['hello', 'world']);
    }, 15000);

    test('retries on 429 rate limit and eventually succeeds', async () => {
        const texts = ['test'];
        const embeddings = [[0.7, 0.8]];

        // First request: 429 rate limit
        enqueueResponse(429, 'Rate limited');
        // Second request: success
        enqueueResponse(200, makeEmbeddingResponse(embeddings));

        const result = await getEmbeddingsBatch(texts, getConfig());

        expect(result).toHaveLength(1);
        expect(result[0]).toEqual([0.7, 0.8]);
        expect(requestLog).toHaveLength(2);
    }, 30000);

    test('returns null entries when all retries fail with server error', async () => {
        const texts = ['fail'];

        // All 3 retry attempts return 500
        enqueueResponse(500, 'Server Error');
        enqueueResponse(500, 'Server Error');
        enqueueResponse(500, 'Server Error');

        const result = await getEmbeddingsBatch(texts, getConfig());

        expect(result).toHaveLength(1);
        expect(result[0]).toBeNull();
        expect(requestLog).toHaveLength(3);
    }, 30000);

    test('result array length always matches input length', async () => {
        const texts = ['a', 'b', 'c', 'd', 'e'];
        const embeddings = texts.map((_, i) => [i * 0.1, i * 0.2]);

        enqueueResponse(200, makeEmbeddingResponse(embeddings));

        const result = await getEmbeddingsBatch(texts, getConfig());

        expect(result).toHaveLength(texts.length);
        result.forEach((emb, i) => {
            expect(emb).toEqual([i * 0.1, i * 0.2]);
        });
    }, 15000);
});
