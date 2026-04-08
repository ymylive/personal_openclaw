/**
 * Tests for routes/admin/config.js
 * Covers: GET/POST config endpoints, error handling, plugin reload
 */

const express = require('express');
const fs = require('fs').promises;
const path = require('path');

// We need to mock fs.promises
jest.mock('fs', () => {
    const originalFs = jest.requireActual('fs');
    return {
        ...originalFs,
        promises: {
            readFile: jest.fn(),
            writeFile: jest.fn()
        }
    };
});

const configRouteFactory = require('../../routes/admin/config');

// Helper to create a test app with the router
function createTestApp() {
    const mockPluginManager = {
        loadPlugins: jest.fn().mockResolvedValue(undefined)
    };

    const app = express();
    app.use(express.json());
    const router = configRouteFactory({ pluginManager: mockPluginManager });
    app.use('/', router);

    return { app, mockPluginManager };
}

// Simple supertest-like helper using native http
const http = require('http');

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
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe('GET /config/main', () => {
    test('returns file content on success', async () => {
        fs.readFile.mockResolvedValue('API_KEY=test123\nMODEL=gpt-4');

        const { app } = createTestApp();
        const res = await request(app).get('/config/main');

        expect(res.status).toBe(200);
        expect(res.body.content).toBe('API_KEY=test123\nMODEL=gpt-4');
    });

    test('returns 500 when file read fails', async () => {
        fs.readFile.mockRejectedValue(new Error('ENOENT: no such file'));

        const { app } = createTestApp();
        const res = await request(app).get('/config/main');

        expect(res.status).toBe(500);
        expect(res.body.error).toContain('Failed to read');
    });
});

describe('POST /config/main', () => {
    test('writes content and reloads plugins', async () => {
        fs.writeFile.mockResolvedValue(undefined);

        const { app, mockPluginManager } = createTestApp();
        const res = await request(app).post('/config/main', { content: 'NEW_KEY=value' });

        expect(res.status).toBe(200);
        expect(res.body.message).toBeTruthy();
        expect(fs.writeFile).toHaveBeenCalledWith(
            expect.stringContaining('config.env'),
            'NEW_KEY=value',
            'utf-8'
        );
        expect(mockPluginManager.loadPlugins).toHaveBeenCalledTimes(1);
    });

    test('returns 400 for non-string content', async () => {
        const { app } = createTestApp();
        const res = await request(app).post('/config/main', { content: 12345 });

        expect(res.status).toBe(400);
        expect(res.body.error).toContain('Invalid content format');
    });

    test('returns 500 when write fails', async () => {
        fs.writeFile.mockRejectedValue(new Error('EACCES: permission denied'));

        const { app } = createTestApp();
        const res = await request(app).post('/config/main', { content: 'data' });

        expect(res.status).toBe(500);
        expect(res.body.error).toContain('Failed to write');
    });
});

describe('GET /tool-approval-config', () => {
    test('returns parsed JSON config on success', async () => {
        const mockConfig = { enabled: true, timeoutMinutes: 10, approveAll: false, approvalList: ['tool1'] };
        fs.readFile.mockResolvedValue(JSON.stringify(mockConfig));

        const { app } = createTestApp();
        const res = await request(app).get('/tool-approval-config');

        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(true);
        expect(res.body.approvalList).toEqual(['tool1']);
    });

    test('returns default config when file not found', async () => {
        const err = new Error('File not found');
        err.code = 'ENOENT';
        fs.readFile.mockRejectedValue(err);

        const { app } = createTestApp();
        const res = await request(app).get('/tool-approval-config');

        expect(res.status).toBe(200);
        expect(res.body.enabled).toBe(false);
        expect(res.body.timeoutMinutes).toBe(5);
    });
});
