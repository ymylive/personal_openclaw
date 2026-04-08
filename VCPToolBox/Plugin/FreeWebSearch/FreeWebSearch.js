#!/usr/bin/env node
/**
 * FreeWebSearch - 免费多引擎聚合搜索插件
 * 后端调用 open-websearch daemon (http://127.0.0.1:3088)
 * 支持 baidu, bing, duckduckgo, brave, startpage, wikipedia 等引擎，无需 API Key
 * VCPToolBox 同步插件，使用 stdio 协议通信。
 */

const http = require('http');
const readline = require('readline');

// 容器内用宿主机桥接IP，宿主机用 localhost
const DAEMON_URL = process.env.SEARCH_DAEMON_URL || 'http://172.17.0.1:3088';

// 可用引擎列表
const AVAILABLE_ENGINES = ['baidu', 'bing', 'duckduckgo', 'brave', 'startpage', 'wikipedia'];
const DEFAULT_ENGINES = ['baidu', 'startpage'];

/**
 * HTTP POST 请求
 */
function httpPost(url, data) {
    return new Promise((resolve, reject) => {
        const body = JSON.stringify(data);
        const parsed = new URL(url);
        const req = http.request({
            hostname: parsed.hostname,
            port: parsed.port,
            path: parsed.pathname,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            timeout: 15000
        }, (res) => {
            let chunks = '';
            res.on('data', c => chunks += c);
            res.on('end', () => {
                try { resolve(JSON.parse(chunks)); }
                catch (e) { reject(new Error(`JSON parse error: ${chunks.substring(0, 200)}`)); }
            });
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
        req.write(body);
        req.end();
    });
}

/**
 * 搜索单个引擎
 */
async function searchEngine(query, engine, count) {
    try {
        const result = await httpPost(`${DAEMON_URL}/search`, {
            query,
            engines: [engine],
            count: count
        });
        if (result.status === 'ok' && result.data) {
            return {
                engine,
                results: (result.data.results || []).map(r => ({
                    title: (r.title || '').replace(/\s+/g, ' ').trim(),
                    url: r.url || '',
                    description: (r.description || r.snippet || '').replace(/\s+/g, ' ').trim().substring(0, 300)
                })).filter(r => r.title && r.url),
                error: null
            };
        }
        return { engine, results: [], error: result.error || 'unknown error' };
    } catch (e) {
        return { engine, results: [], error: e.message };
    }
}

/**
 * Wikipedia 搜索（直接用 API，不走 daemon）
 */
async function searchWikipedia(query, count) {
    return new Promise((resolve) => {
        const url = `https://zh.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}&format=json&utf8=1&srlimit=${count}`;
        const https = require('https');
        https.get(url, { headers: { 'User-Agent': 'VCPToolBox/1.0 (search plugin)' }, timeout: 10000 }, (res) => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const d = JSON.parse(data);
                    const results = (d.query?.search || []).map(r => ({
                        title: r.title,
                        url: `https://zh.wikipedia.org/wiki/${encodeURIComponent(r.title)}`,
                        description: (r.snippet || '').replace(/<[^>]+>/g, '').substring(0, 300)
                    }));
                    resolve({ engine: 'wikipedia', results, error: null });
                } catch (e) {
                    resolve({ engine: 'wikipedia', results: [], error: e.message });
                }
            });
        }).on('error', e => resolve({ engine: 'wikipedia', results: [], error: e.message }));
    });
}

/**
 * 多引擎并行搜索
 */
async function multiSearch(query, engines, maxResults) {
    const tasks = engines.map(engine => {
        if (engine === 'wikipedia') return searchWikipedia(query, maxResults);
        return searchEngine(query, engine, maxResults);
    });
    return Promise.all(tasks);
}

/**
 * 格式化搜索结果
 */
function formatResults(engineResults) {
    let output = '';
    let totalCount = 0;

    for (const { engine, results, error } of engineResults) {
        const name = engine.charAt(0).toUpperCase() + engine.slice(1);
        output += `=== ${name} 搜索结果 ===\n`;
        if (error && results.length === 0) {
            output += `(搜索失败: ${error})\n`;
        } else if (results.length === 0) {
            output += `(无结果)\n`;
        } else {
            results.forEach((r, i) => {
                output += `${i + 1}. [${r.title}](${r.url})\n`;
                if (r.description) output += `   ${r.description}\n`;
                output += '\n';
                totalCount++;
            });
        }
        output += '\n';
    }
    return { output: output.trim(), totalCount };
}

/**
 * 处理请求
 */
async function processRequest(request) {
    const query = request.query || request.q || request.text;
    if (!query) {
        return { status: 'error', error: '缺少搜索关键词。请提供 query 参数。' };
    }

    const maxResults = parseInt(request.max_results || request.count || '5', 10);

    // 解析引擎
    let engines;
    const enginesInput = request.engines || request.engine;
    if (enginesInput) {
        if (Array.isArray(enginesInput)) {
            engines = enginesInput;
        } else {
            engines = enginesInput.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
        }
    } else {
        engines = [...DEFAULT_ENGINES];
    }

    // 验证引擎
    const validEngines = engines.filter(e => AVAILABLE_ENGINES.includes(e));
    if (validEngines.length === 0) {
        return { status: 'error', error: `无有效引擎。可选: ${AVAILABLE_ENGINES.join(', ')}` };
    }

    try {
        const results = await multiSearch(query, validEngines, maxResults);
        const { output, totalCount } = formatResults(results);
        // VCP Plugin.js 期望 {status:"success", result: 数据}
        // ToolExecutor._formatResult 会从 result.content 数组提取文本
        return {
            status: 'success',
            result: {
                content: [{ type: 'text', text: output }],
                resultCount: totalCount
            }
        };
    } catch (e) {
        return { status: 'error', error: `搜索失败: ${e.message}` };
    }
}

// VCP stdio 协议：读取一行 JSON 输入，处理后输出结果并退出
const rl = readline.createInterface({ input: process.stdin });
rl.on('line', async (line) => {
    try {
        const request = JSON.parse(line);
        const result = await processRequest(request);
        process.stdout.write(JSON.stringify(result) + '\n');
    } catch (e) {
        process.stdout.write(JSON.stringify({ status: 'error', error: e.message }) + '\n');
    }
    // 同步插件必须在输出后退出，否则 VCP 等不到 exit 事件
    rl.close();
    process.exit(0);
});
