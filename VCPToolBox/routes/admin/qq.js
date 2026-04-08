const express = require('express');
const WebSocket = require('ws');
const fs = require('fs').promises;
const path = require('path');

module.exports = function(options) {
    const router = express.Router();

    /**
     * 从 config.env 解析 QQ_WS_URL 和 QQ_ACCESS_TOKEN
     */
    async function getQQConfig() {
        try {
            const configPath = path.join(__dirname, '..', '..', 'config.env');
            const content = await fs.readFile(configPath, 'utf-8');
            const config = {};
            for (const line of content.split('\n')) {
                const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
                if (match) {
                    config[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
                }
            }
            return config;
        } catch (e) {
            return {};
        }
    }

    /**
     * GET /admin_api/qq/status
     * 通过 WebSocket 探针检测 NapCat 是否可连接
     */
    router.get('/qq/status', async (req, res) => {
        const config = await getQQConfig();
        const wsUrl = config.QQ_WS_URL || 'ws://127.0.0.1:3001';
        const accessToken = config.QQ_ACCESS_TOKEN || '';

        // 检查是否配置了 QQ Bot 自身 ID（未配置视为未启用）
        if (!config.QQ_BOT_SELF_IDS) {
            return res.json({ status: 'stopped', message: '未配置机器人 QQ 号' });
        }

        const url = accessToken ? `${wsUrl}?access_token=${accessToken}` : wsUrl;

        try {
            const status = await new Promise((resolve) => {
                const timeout = setTimeout(() => {
                    try { ws.close(); } catch (e) {}
                    resolve({ status: 'disconnected', message: '连接超时' });
                }, 5000);

                const ws = new WebSocket(url, { handshakeTimeout: 5000 });

                ws.on('open', () => {
                    clearTimeout(timeout);
                    ws.close();
                    resolve({ status: 'connected', message: 'NapCat WebSocket 可达' });
                });

                ws.on('error', (err) => {
                    clearTimeout(timeout);
                    try { ws.close(); } catch (e) {}
                    resolve({ status: 'disconnected', message: err.message });
                });
            });

            res.json(status);
        } catch (error) {
            res.json({ status: 'error', message: error.message });
        }
    });

    /**
     * POST /admin_api/qq/restart
     * 重启 QQ Bot（通过 PM2 重启名为 qqBot 的进程）
     */
    router.post('/qq/restart', async (req, res) => {
        try {
            const pm2 = require('pm2');
            pm2.restart('qqBot', (err) => {
                if (err) {
                    // PM2 没找到该进程名，尝试其他常见名
                    pm2.restart('qq-bot', (err2) => {
                        if (err2) {
                            return res.status(500).json({
                                success: false,
                                error: '未找到 QQ Bot 进程。请确认进程名为 "qqBot" 或 "qq-bot"，并通过 PM2 管理。',
                                details: err.message
                            });
                        }
                        res.json({ success: true, message: 'QQ Bot 进程 (qq-bot) 已重启' });
                    });
                } else {
                    res.json({ success: true, message: 'QQ Bot 进程 (qqBot) 已重启' });
                }
            });
        } catch (error) {
            res.status(500).json({ success: false, error: '重启失败', details: error.message });
        }
    });

    return router;
};
