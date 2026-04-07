#!/usr/bin/env node
/**
 * FreeWebSearch - 免费多引擎聚合搜索插件
 * 支持 DuckDuckGo、Brave Search、Wikipedia，无需任何 API Key。
 * VCPToolBox 同步插件，使用 stdio 协议通信。
 */

const https = require('https');
const http = require('http');
const { URL } = require('url');
const readline = require('readline');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------
const REQUEST_TIMEOUT = 10000; // 每个 HTTP 请求 10 秒超时
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const WIKI_USER_AGENT = 'VCPToolBox-FreeWebSearch/1.0 (https://github.com/aspect-build/rules_lint; vcptoolbox@users.noreply.github.com)';

// ---------------------------------------------------------------------------
// 通用 HTTP 请求（仅使用 Node 内置模块，支持自动重定向）
// ---------------------------------------------------------------------------
function httpGet(url, headers = {}, maxRedirects = 5) {
    return new Promise((resolve, reject) => {
        if (maxRedirects <= 0) {
            return reject(new Error('重定向次数过多'));
        }

        const parsedUrl = new URL(url);
        const lib = parsedUrl.protocol === 'https:' ? https : http;

        const options = {
            hostname: parsedUrl.hostname,
            port: parsedUrl.port,
            path: parsedUrl.pathname + parsedUrl.search,
            method: 'GET',
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,application/json;q=0.8,*/*;q=0.7',
                'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
                ...headers
            },
            timeout: REQUEST_TIMEOUT
        };

        const req = lib.request(options, (res) => {
            // 处理重定向
            if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
                let redirectUrl = res.headers.location;
                if (redirectUrl.startsWith('/')) {
                    redirectUrl = `${parsedUrl.protocol}//${parsedUrl.host}${redirectUrl}`;
                }
                return resolve(httpGet(redirectUrl, headers, maxRedirects - 1));
            }

            const chunks = [];
            res.on('data', (chunk) => chunks.push(chunk));
            res.on('end', () => {
                const body = Buffer.concat(chunks).toString('utf-8');
                resolve({ statusCode: res.statusCode, headers: res.headers, body });
            });
        });

        req.on('timeout', () => { req.destroy(); reject(new Error(`请求超时: ${url}`)); });
        req.on('error', (err) => reject(err));
        req.end();
    });
}

// ---------------------------------------------------------------------------
// HTML 实体解码
// ---------------------------------------------------------------------------
function decodeHtmlEntities(text) {
    if (!text) return '';
    return text
        .replace(/&amp;/g, '&')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&#x27;/g, "'")
        .replace(/&#x2F;/g, '/')
        .replace(/&nbsp;/g, ' ')
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(parseInt(code, 10)))
        .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

// 去除 HTML 标签
function stripHtml(html) {
    if (!html) return '';
    return decodeHtmlEntities(html.replace(/<[^>]*>/g, '')).trim();
}

// ---------------------------------------------------------------------------
// DuckDuckGo 搜索
// ---------------------------------------------------------------------------
async function searchDuckDuckGo(query, maxResults, language) {
    const results = [];
    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://html.duckduckgo.com/html/?q=${encodedQuery}`;
        const response = await httpGet(url, {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': language || 'zh-CN,zh;q=0.9,en;q=0.8',
            'Accept-Encoding': 'identity',
            'Referer': 'https://html.duckduckgo.com/',
            'Cookie': 'kl=wt-wt',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'same-origin'
        });

        // 如果 html 版返回非200，尝试 lite 版
        if (response.statusCode !== 200) {
            const liteUrl = `https://lite.duckduckgo.com/lite/?q=${encodedQuery}`;
            const liteResp = await httpGet(liteUrl, {
                'Accept': 'text/html,application/xhtml+xml',
                'Accept-Language': language || 'zh-CN,zh;q=0.9,en;q=0.8',
                'Referer': 'https://lite.duckduckgo.com/'
            });
            if (liteResp.statusCode === 200) {
                // lite 版格式：<a rel="nofollow" href="URL" class='result-link'>Title</a> 和 <td class="result-snippet">Snippet</td>
                const liteBlock = /<a[^>]*class='result-link'[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<td[^>]*class="result-snippet"[^>]*>([\s\S]*?)<\/td>/gi;
                let lm;
                while ((lm = liteBlock.exec(liteResp.body)) !== null && results.length < maxResults) {
                    const href = decodeHtmlEntities(lm[1]);
                    const title = stripHtml(lm[2]);
                    const snippet = stripHtml(lm[3]);
                    if (title && href && !href.includes('duckduckgo.com')) {
                        results.push({ title, url: href, snippet: snippet || '' });
                    }
                }
                if (results.length > 0) return results;
            }
            throw new Error(`DuckDuckGo 返回状态码 ${response.statusCode}`);
        }

        const html = response.body;

        // 方案1: 匹配 result 块 —— 每个结果在 <div class="links_main ... "> 或 class="result results_links ..."
        // DuckDuckGo HTML 版本的结构: 每个结果包含 class="result__a" 的链接和 class="result__snippet" 的摘要
        const resultBlockRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

        let match;
        while ((match = resultBlockRegex.exec(html)) !== null && results.length < maxResults) {
            let href = decodeHtmlEntities(match[1]);
            const title = stripHtml(match[2]);
            const snippet = stripHtml(match[3]);

            // DuckDuckGo 的链接可能是通过 uddg 参数重定向的
            if (href.includes('uddg=')) {
                try {
                    const uddgMatch = href.match(/uddg=([^&]+)/);
                    if (uddgMatch) {
                        href = decodeURIComponent(uddgMatch[1]);
                    }
                } catch (e) { /* 保留原始 URL */ }
            }

            if (title && href && !href.startsWith('/') && !href.includes('duckduckgo.com')) {
                results.push({ title, url: href, snippet: snippet || '' });
            }
        }

        // 方案2: 如果方案1没有匹配到，尝试更宽松的匹配
        if (results.length === 0) {
            const looseRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
            const snippetRegex = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/gi;

            const links = [];
            let linkMatch;
            while ((linkMatch = looseRegex.exec(html)) !== null) {
                links.push({ href: decodeHtmlEntities(linkMatch[1]), title: stripHtml(linkMatch[2]) });
            }

            const snippets = [];
            let snippetMatch;
            while ((snippetMatch = snippetRegex.exec(html)) !== null) {
                snippets.push(stripHtml(snippetMatch[1]));
            }

            for (let i = 0; i < Math.min(links.length, maxResults); i++) {
                let href = links[i].href;
                if (href.includes('uddg=')) {
                    try {
                        const uddgMatch = href.match(/uddg=([^&]+)/);
                        if (uddgMatch) href = decodeURIComponent(uddgMatch[1]);
                    } catch (e) { /* ignore */ }
                }
                if (links[i].title && href && !href.startsWith('/') && !href.includes('duckduckgo.com')) {
                    results.push({
                        title: links[i].title,
                        url: href,
                        snippet: snippets[i] || ''
                    });
                }
            }
        }

    } catch (err) {
        return { engine: 'DuckDuckGo', error: err.message, results: [] };
    }
    return { engine: 'DuckDuckGo', results };
}

// ---------------------------------------------------------------------------
// Brave Search
// ---------------------------------------------------------------------------
async function searchBrave(query, maxResults, language) {
    const results = [];
    try {
        const encodedQuery = encodeURIComponent(query);
        const url = `https://search.brave.com/search?q=${encodedQuery}&source=web`;
        const response = await httpGet(url, {
            'Accept': 'text/html',
            'Accept-Language': language || 'zh-CN,zh;q=0.9,en;q=0.8'
        });

        if (response.statusCode !== 200) {
            throw new Error(`Brave Search 返回状态码 ${response.statusCode}`);
        }

        const html = response.body;

        // Brave 搜索结果结构: <div class="snippet ...">
        // 标题在 <a class="heading-serpresult" 或 <a class="result-header" 中
        // 摘要在 <div class="snippet-description" 或 <p class="snippet-description" 中

        // 尝试匹配 Brave 的搜索结果块
        // 模式: 找到包含标题链接和摘要的块
        const braveBlockRegex = /<div[^>]*class="[^"]*snippet[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>/gi;
        const titleLinkRegex = /<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/i;
        const descRegex = /<div[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/div>/i;
        const descRegex2 = /<p[^>]*class="[^"]*snippet-description[^"]*"[^>]*>([\s\S]*?)<\/p>/i;

        let blockMatch;
        while ((blockMatch = braveBlockRegex.exec(html)) !== null && results.length < maxResults) {
            const block = blockMatch[1];
            const linkMatch = titleLinkRegex.exec(block);
            const dMatch = descRegex.exec(block) || descRegex2.exec(block);

            if (linkMatch) {
                const href = decodeHtmlEntities(linkMatch[1]);
                const title = stripHtml(linkMatch[2]);
                const snippet = dMatch ? stripHtml(dMatch[1]) : '';

                if (title && href && href.startsWith('http')) {
                    results.push({ title, url: href, snippet });
                }
            }
        }

        // 备选: 更宽松的匹配 - 查找所有带有 heading-serpresult 或 result-header 类的链接
        if (results.length === 0) {
            const altRegex = /<a[^>]*class="[^"]*(?:heading-serpresult|result-header)[^"]*"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi;
            let altMatch;
            while ((altMatch = altRegex.exec(html)) !== null && results.length < maxResults) {
                const href = decodeHtmlEntities(altMatch[1]);
                const title = stripHtml(altMatch[2]);
                if (title && href && href.startsWith('http')) {
                    results.push({ title, url: href, snippet: '' });
                }
            }
        }

        // 第三备选: 寻找任何 data-type="web" 的结果
        if (results.length === 0) {
            const webResultRegex = /<div[^>]*data-type="web"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/gi;
            let wrMatch;
            while ((wrMatch = webResultRegex.exec(html)) !== null && results.length < maxResults) {
                const block = wrMatch[1];
                const lm = /<a[^>]*href="(https?:\/\/[^"]*)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
                if (lm) {
                    results.push({
                        title: stripHtml(lm[2]),
                        url: decodeHtmlEntities(lm[1]),
                        snippet: ''
                    });
                }
            }
        }

    } catch (err) {
        return { engine: 'Brave', error: err.message, results: [] };
    }
    return { engine: 'Brave', results };
}

// ---------------------------------------------------------------------------
// Wikipedia 搜索
// ---------------------------------------------------------------------------
async function searchWikipedia(query, maxResults, language) {
    const results = [];
    try {
        // 根据语言选择 Wikipedia 域名
        let wikiLang = 'zh';
        if (language) {
            const langCode = language.split('-')[0].toLowerCase();
            if (['en', 'ja', 'ko', 'fr', 'de', 'es', 'ru', 'pt', 'it'].includes(langCode)) {
                wikiLang = langCode;
            }
        }

        const encodedQuery = encodeURIComponent(query);
        const limit = Math.min(maxResults, 10);
        const url = `https://${wikiLang}.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodedQuery}&format=json&utf8=1&srlimit=${limit}`;

        const response = await httpGet(url, {
            'Accept': 'application/json',
            'User-Agent': WIKI_USER_AGENT
        });

        if (response.statusCode !== 200) {
            throw new Error(`Wikipedia API 返回状态码 ${response.statusCode}`);
        }

        const data = JSON.parse(response.body);
        if (data.query && data.query.search) {
            for (const item of data.query.search) {
                const title = item.title;
                const snippet = stripHtml(item.snippet);
                const pageUrl = `https://${wikiLang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
                results.push({ title, url: pageUrl, snippet });
            }
        }

    } catch (err) {
        return { engine: 'Wikipedia', error: err.message, results: [] };
    }
    return { engine: 'Wikipedia', results };
}

// ---------------------------------------------------------------------------
// 引擎路由
// ---------------------------------------------------------------------------
const ENGINE_MAP = {
    'duckduckgo': searchDuckDuckGo,
    'ddg': searchDuckDuckGo,
    'brave': searchBrave,
    'wikipedia': searchWikipedia,
    'wiki': searchWikipedia
};

// ---------------------------------------------------------------------------
// 结果去重
// ---------------------------------------------------------------------------
function deduplicateResults(engineResults) {
    const seenUrls = new Set();
    for (const er of engineResults) {
        const deduped = [];
        for (const r of er.results) {
            // 标准化 URL 用于去重
            const normalizedUrl = r.url.replace(/\/+$/, '').replace(/^https?:\/\//, '');
            if (!seenUrls.has(normalizedUrl)) {
                seenUrls.add(normalizedUrl);
                deduped.push(r);
            }
        }
        er.results = deduped;
    }
    return engineResults;
}

// ---------------------------------------------------------------------------
// 格式化输出
// ---------------------------------------------------------------------------
function formatResults(engineResults) {
    const parts = [];
    let totalCount = 0;

    for (const er of engineResults) {
        if (er.error && er.results.length === 0) {
            parts.push(`=== ${er.engine} 搜索结果 ===\n(搜索失败: ${er.error})\n`);
            continue;
        }
        if (er.results.length === 0) {
            parts.push(`=== ${er.engine} 搜索结果 ===\n(无结果)\n`);
            continue;
        }

        const lines = [`=== ${er.engine} 搜索结果 ===`];
        er.results.forEach((r, i) => {
            lines.push(`${i + 1}. [${r.title}](${r.url})`);
            if (r.snippet) {
                lines.push(`   ${r.snippet}`);
            }
            lines.push('');
        });
        parts.push(lines.join('\n'));
        totalCount += er.results.length;
    }

    return { formatted: parts.join('\n'), totalCount };
}

// ---------------------------------------------------------------------------
// 处理请求
// ---------------------------------------------------------------------------
async function processRequest(request) {
    try {
        const query = request.query;
        if (!query || typeof query !== 'string' || query.trim().length === 0) {
            return { success: false, error: '缺少必需参数: query (搜索关键词)' };
        }

        const enginesStr = (request.engines || 'brave,wikipedia').toLowerCase().trim();
        const maxResults = parseInt(request.max_results, 10) || 5;
        const language = request.language || 'zh-CN';

        // 解析引擎列表
        const engineNames = enginesStr.split(',').map(e => e.trim()).filter(Boolean);
        const validEngines = [];
        const unknownEngines = [];

        for (const name of engineNames) {
            if (ENGINE_MAP[name]) {
                validEngines.push({ name, fn: ENGINE_MAP[name] });
            } else {
                unknownEngines.push(name);
            }
        }

        if (validEngines.length === 0) {
            return {
                success: false,
                error: `没有有效的搜索引擎。可选: duckduckgo, brave, wikipedia。无法识别: ${unknownEngines.join(', ')}`
            };
        }

        // 并行执行所有引擎搜索
        const searchPromises = validEngines.map(e => e.fn(query, maxResults, language));
        const engineResults = await Promise.all(searchPromises);

        // 去重
        const dedupedResults = deduplicateResults(engineResults);

        // 格式化输出
        const { formatted, totalCount } = formatResults(dedupedResults);

        // 添加未知引擎警告
        let output = formatted;
        if (unknownEngines.length > 0) {
            output += `\n[提示] 未识别的引擎已跳过: ${unknownEngines.join(', ')}。可选: duckduckgo, brave, wikipedia\n`;
        }

        return {
            success: true,
            data: output,
            resultCount: totalCount
        };

    } catch (err) {
        return { success: false, error: `搜索处理失败: ${err.message}` };
    }
}

// ---------------------------------------------------------------------------
// VCP stdio 协议入口
// ---------------------------------------------------------------------------
const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
    try {
        const request = JSON.parse(line);
        const result = await processRequest(request);
        process.stdout.write(JSON.stringify(result) + '\n');
    } catch (e) {
        process.stdout.write(JSON.stringify({ success: false, error: `请求解析失败: ${e.message}` }) + '\n');
    }
});

// 处理进程信号
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
