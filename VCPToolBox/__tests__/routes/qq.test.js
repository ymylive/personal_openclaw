/**
 * Tests for routes/admin/qq.js
 * Covers: GET /qq/status (not configured, WebSocket probe), POST /qq/restart (PM2 mock)
 */

const express = require('express');
const http = require('http');
const EventEmitter = require('events');

// Mock fs.promises
jest.mock('fs', () => {
    const originalFs = jest.requireActual('fs');
    return {
        ...originalFs,
        promises: {
            readFile: jest.fn()
        }
    };
});

// Mock ws module
jest.mock('ws', () => {
    return jest.fn();
});

// Mock pm2 module
jest.mock('pm2', () => ({
    restart: jest.fn()
}));

const fs = require('fs').promises;
const WebSocket = require('ws');
const pm2 = require('pm2');
const qqRouteFactory = require('../../routes/admin/qq');

function createTestApp() {
    const app = express();
    app.use(express.json());
    const router = qqRouteFactory({});
    app.use('/', router);
    return app;
}

function request(app) {
    const server = http.createServer(app);

    function makeRequest(method, urlPath, body) {
        return new Promise((resolve, reject) => {
            server.listen(0, () => {
                const port = server.address().port;
                const options = {
                    hostname: '127.0.0.1',
                    port,
                    path: urlPath,
                    method,
                    headers: { 'Content-Type': 'application/json' }
                };

                const req = http.request(options, (res) => {
                    let data = '';
                    res.on('data', chunk => data += chunk);
                    res.on('end', () => {
                        server.close();
                        try {
                            resolve({ status: res.statusCode, body: JSON.parse(data) });
                        } catch {
                            resolve({ status: res.statusCode, body: data });
                        }
                    });
                });

                req.on('error', (err) => {
                    server.close();
                    reject(err);
                });

                if (body) req.write(JSON.stringify(body));
                req.end();
            });
        });
    }

    return {
        get: (url) => makeRequest('GET', url),
        post: (url, body) => makeRequest('POST', url, body)
    };
}

beforeEach(() => {
    jest.clearAllMocks();
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('GET /qq/status', () => {
    test('returns stopped when QQ_BOT_SELF_IDS is not configured', async () => {
        fs.readFile.mockResolvedValue('QQ_WS_URL=ws://localhost:3001\n');

        const app = createTestApp();
        const res = await request(app).get('/qq/status');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('stopped');
        expect(res.body.message).toContain('未配置');
    });

    test('returns connected when WebSocket connects successfully', async () => {
        fs.readFile.mockResolvedValue('QQ_BOT_SELF_IDS=12345\nQQ_WS_URL=ws://localhost:3001\n');

        // Mock WebSocket constructor to simulate successful connection
        WebSocket.mockImplementation((url, opts) => {
            const ws = new EventEmitter();
            ws.close = jest.fn();
            // Simulate connection on next tick
            process.nextTick(() => ws.emit('open'));
            return ws;
        });

        const app = createTestApp();
        const res = await request(app).get('/qq/status');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('connected');
    });

    test('returns disconnected when WebSocket connection fails', async () => {
        fs.readFile.mockResolvedValue('QQ_BOT_SELF_IDS=12345\nQQ_WS_URL=ws://localhost:3001\n');

        WebSocket.mockImplementation((url, opts) => {
            const ws = new EventEmitter();
            ws.close = jest.fn();
            process.nextTick(() => ws.emit('error', new Error('ECONNREFUSED')));
            return ws;
        });

        const app = createTestApp();
        const res = await request(app).get('/qq/status');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('disconnected');
        expect(res.body.message).toContain('ECONNREFUSED');
    });

    test('returns stopped when config file is missing', async () => {
        fs.readFile.mockRejectedValue(new Error('ENOENT'));

        const app = createTestApp();
        const res = await request(app).get('/qq/status');

        expect(res.status).toBe(200);
        expect(res.body.status).toBe('stopped');
    });
});

describe('POST /qq/restart', () => {
    test('restarts qqBot process successfully', async () => {
        pm2.restart.mockImplementation((name, cb) => {
            if (name === 'qqBot') cb(null);
        });

        const app = createTestApp();
        const res = await request(app).post('/qq/restart', {});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('qqBot');
    });

    test('falls back to qq-bot process name when qqBot fails', async () => {
        pm2.restart.mockImplementation((name, cb) => {
            if (name === 'qqBot') cb(new Error('not found'));
            else if (name === 'qq-bot') cb(null);
        });

        const app = createTestApp();
        const res = await request(app).post('/qq/restart', {});

        expect(res.status).toBe(200);
        expect(res.body.success).toBe(true);
        expect(res.body.message).toContain('qq-bot');
    });

    test('returns 500 when both process names fail', async () => {
        pm2.restart.mockImplementation((name, cb) => {
            cb(new Error('process not found'));
        });

        const app = createTestApp();
        const res = await request(app).post('/qq/restart', {});

        expect(res.status).toBe(500);
        expect(res.body.success).toBe(false);
        expect(res.body.error).toContain('未找到');
    });
});
