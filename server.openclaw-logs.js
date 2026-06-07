'use strict';

/**
 * OpenClaw / WeChat QR log integration for hf-space-manager.
 *
 * Mount in server.js:
 *   const openclawLogs = require('./server.openclaw-logs');
 *   app.use(openclawLogs({ requireLogin, sessionTokens }));
 *
 * Then open in browser:
 *   /openclaw-logs.html
 *
 * Environment:
 *   HF_TOKEN=hf_xxx
 *   Optional: HF_LOG_ALLOW_PUBLIC=1 to disable login guard for read-only log API.
 */

const express = require('express');
const axios = require('axios');

const HF_BASE = 'https://huggingface.co';

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function sanitizeRepoId(input) {
  const repoId = String(input || '').trim();
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repoId)) return '';
  return repoId;
}

function getBearerToken(req) {
  const auth = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(auth);
  return m ? m[1] : '';
}

function createLoginGuard(options) {
  const allowPublic = envFlag('HF_LOG_ALLOW_PUBLIC', false);
  const requireLogin = options && options.requireLogin;
  const sessionTokens = options && options.sessionTokens;

  return function loginGuard(req, res, next) {
    if (allowPublic) return next();

    if (typeof requireLogin === 'function') {
      return requireLogin(req, res, next);
    }

    // Compatible with common hf-space-manager implementations that use
    // a Set named sessionTokens and Bearer token authorization.
    if (sessionTokens && typeof sessionTokens.has === 'function') {
      const token = getBearerToken(req);
      if (token && sessionTokens.has(token)) return next();
    }

    return res.status(401).json({ error: 'Unauthorized. Login first or set HF_LOG_ALLOW_PUBLIC=1.' });
  };
}

function pickHfToken(req) {
  // Do not send HF token to frontend. This is backend-only.
  // Default: one Hugging Face account token manages many Spaces.
  return process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || process.env.HF_ACCESS_TOKEN || '';
}

function extractWechatLinks(text) {
  const links = [];
  const re = /https:\/\/liteapp\.weixin\.qq\.com\/q\/[^\s"'<>]+/g;
  let m;
  while ((m = re.exec(text))) links.push(m[0]);
  return Array.from(new Set(links));
}

function extractQrBlock(text) {
  const lines = String(text || '').split(/\r?\n/);
  const blocks = [];
  let current = [];
  let capture = false;
  for (const line of lines) {
    if (/用手机微信扫描以下二维码|QR login starting|二维码/.test(line)) {
      capture = true;
      current = [line];
      continue;
    }
    if (capture) {
      current.push(line);
      if (/正在等待操作|已将此 OpenClaw 连接到微信|Local login saved auth/.test(line)) {
        blocks.push(current.join('\n'));
        capture = false;
        current = [];
      }
      if (current.length > 40) {
        blocks.push(current.join('\n'));
        capture = false;
        current = [];
      }
    }
  }
  if (current.length) blocks.push(current.join('\n'));
  return blocks.slice(-3);
}

function createRouter(options = {}) {
  const router = express.Router();
  const loginGuard = createLoginGuard(options);

  router.get('/api/openclaw/spaces/:owner/:name/logs/run', loginGuard, async (req, res) => {
    const repoId = sanitizeRepoId(`${req.params.owner}/${req.params.name}`);
    if (!repoId) return res.status(400).json({ error: 'Invalid repoId' });

    const hfToken = pickHfToken(req);
    if (!hfToken) return res.status(500).json({ error: 'HF_TOKEN is not configured on server' });

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    const writeEvent = (event, data) => {
      if (closed || res.destroyed) return;
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    writeEvent('open', { repoId, message: 'HF log stream connected' });

    try {
      const url = `${HF_BASE}/api/spaces/${encodeURIComponent(repoId)}/logs/run`;
      const hfResp = await axios.get(url, {
        responseType: 'stream',
        timeout: 0,
        headers: {
          Authorization: `Bearer ${hfToken}`,
          Accept: 'text/plain, */*',
          'User-Agent': 'hf-space-manager-openclaw-logs/1.0'
        },
        validateStatus: () => true
      });

      if (hfResp.status < 200 || hfResp.status >= 300) {
        let body = '';
        hfResp.data.on('data', chunk => { body += chunk.toString('utf8'); });
        hfResp.data.on('end', () => {
          writeEvent('error', { status: hfResp.status, body: body.slice(0, 2000) });
          res.end();
        });
        return;
      }

      let buffer = '';
      let allRecent = '';
      const heartbeat = setInterval(() => writeEvent('ping', { ts: Date.now() }), 25000);

      hfResp.data.on('data', chunk => {
        if (closed) return;
        const text = chunk.toString('utf8');
        buffer += text;
        allRecent = (allRecent + text).slice(-20000);

        const wechatLinks = extractWechatLinks(text);
        if (wechatLinks.length) writeEvent('wechat-link', { repoId, links: wechatLinks });

        const qrBlocks = extractQrBlock(allRecent);
        if (qrBlocks.length) writeEvent('wechat-qr', { repoId, blocks: qrBlocks });

        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() || '';
        for (const line of parts) writeEvent('log', { repoId, line });
      });

      hfResp.data.on('end', () => {
        clearInterval(heartbeat);
        if (buffer) writeEvent('log', { repoId, line: buffer });
        writeEvent('close', { repoId, message: 'HF log stream ended' });
        res.end();
      });

      hfResp.data.on('error', err => {
        clearInterval(heartbeat);
        writeEvent('error', { message: err.message || String(err) });
        res.end();
      });
    } catch (err) {
      writeEvent('error', { message: err.message || String(err) });
      res.end();
    }
  });

  router.get('/api/openclaw/spaces/:owner/:name/logs/snapshot', loginGuard, async (req, res) => {
    const repoId = sanitizeRepoId(`${req.params.owner}/${req.params.name}`);
    if (!repoId) return res.status(400).json({ error: 'Invalid repoId' });
    const hfToken = pickHfToken(req);
    if (!hfToken) return res.status(500).json({ error: 'HF_TOKEN is not configured on server' });

    try {
      const url = `${HF_BASE}/api/spaces/${encodeURIComponent(repoId)}/logs/run`;
      const hfResp = await axios.get(url, {
        responseType: 'text',
        timeout: Number(process.env.HF_LOG_SNAPSHOT_TIMEOUT_MS || 12000),
        headers: { Authorization: `Bearer ${hfToken}`, Accept: 'text/plain, */*' },
        validateStatus: () => true
      });
      const text = String(hfResp.data || '');
      res.status(hfResp.status).json({
        repoId,
        status: hfResp.status,
        text: text.slice(-30000),
        wechatLinks: extractWechatLinks(text),
        qrBlocks: extractQrBlock(text)
      });
    } catch (err) {
      res.status(500).json({ error: err.message || String(err) });
    }
  });

  return router;
}

module.exports = createRouter;
