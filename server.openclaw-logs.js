'use strict';

/**
 * OpenClaw / WeChat QR log proxy for hf-space-manager.
 *
 * Features:
 * - Backend proxies Hugging Face Space logs, so HF tokens are never exposed to browser.
 * - Supports one HF account with many Spaces via HF_USER="username:hf_xxx".
 * - Also supports HF_TOKEN / HUGGINGFACE_TOKEN / HF_ACCESS_TOKEN.
 * - Extracts WeChat LiteApp login links and QR text blocks from OpenClaw logs.
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

function parseHfUserEnv() {
  const raw = process.env.HF_USER || '';
  const mapping = {};
  const tokens = [];

  raw.split(',').forEach(pair => {
    const index = pair.indexOf(':');
    if (index <= 0) return;
    const username = pair.slice(0, index).trim();
    const token = pair.slice(index + 1).trim();
    if (username && token) {
      mapping[username] = token;
      tokens.push(token);
    }
  });

  return { mapping, tokens };
}

function normalizeUserTokenMapping(input) {
  const mapping = {};
  if (!input || typeof input !== 'object') return mapping;
  for (const [key, value] of Object.entries(input)) {
    if (key && value) mapping[String(key)] = String(value);
  }
  return mapping;
}

function pickHfToken(req, repoId, options = {}) {
  if (typeof options.getHfToken === 'function') {
    const token = options.getHfToken(req, repoId);
    if (token) return token;
  }

  // Explicit single-token env, useful for one account managing many Spaces.
  const explicit = process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || process.env.HF_ACCESS_TOKEN;
  if (explicit) return explicit;

  const owner = String(repoId || '').split('/')[0];
  const injectedMapping = normalizeUserTokenMapping(options.userTokenMapping);
  if (owner && injectedMapping[owner]) return injectedMapping[owner];

  const fromEnv = parseHfUserEnv();
  if (owner && fromEnv.mapping[owner]) return fromEnv.mapping[owner];

  // One account, many instances: if only one token exists, use it for any Space.
  const injectedTokens = Object.values(injectedMapping).filter(Boolean);
  if (injectedTokens.length === 1) return injectedTokens[0];
  if (fromEnv.tokens.length === 1) return fromEnv.tokens[0];

  return '';
}

function createLoginGuard(options) {
  const allowPublic = envFlag('HF_LOG_ALLOW_PUBLIC', false);
  const requireLogin = options && options.requireLogin;
  const sessions = options && options.sessions;
  const sessionTokens = options && options.sessionTokens;

  return function loginGuard(req, res, next) {
    if (allowPublic) return next();

    if (typeof requireLogin === 'function') {
      return requireLogin(req, res, next);
    }

    const token = getBearerToken(req);

    if (sessions && typeof sessions.get === 'function') {
      const session = sessions.get(token);
      if (session && (!session.expiresAt || session.expiresAt > Date.now())) {
        req.session = session;
        return next();
      }
    }

    if (sessionTokens && typeof sessionTokens.has === 'function') {
      if (token && sessionTokens.has(token)) return next();
    }

    return res.status(401).json({
      error: 'Unauthorized. Login first, use fetch Authorization, or set HF_LOG_ALLOW_PUBLIC=1.'
    });
  };
}

function extractWechatLinks(text) {
  const links = [];
  const re = /https:\/\/liteapp\.weixin\.qq\.com\/q\/[^\s"'<>]+/g;
  let m;
  while ((m = re.exec(String(text || '')))) links.push(m[0]);
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

      if (/正在等待操作|已将此 OpenClaw 连接到微信|Local login saved auth|Gateway target/.test(line)) {
        blocks.push(current.join('\n'));
        capture = false;
        current = [];
      }

      if (current.length > 60) {
        blocks.push(current.join('\n'));
        capture = false;
        current = [];
      }
    }
  }

  if (current.length) blocks.push(current.join('\n'));
  return blocks.slice(-3);
}

function writeSse(res, event, data) {
  if (res.destroyed || res.writableEnded) return;
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function hfLogsUrl(repoId) {
  return `${HF_BASE}/api/spaces/${encodeURIComponent(repoId)}/logs/run`;
}

function createRouter(options = {}) {
  const router = express.Router();
  const loginGuard = createLoginGuard(options);

  router.get('/api/openclaw/health', (req, res) => {
    const envParsed = parseHfUserEnv();
    res.json({
      ok: true,
      mounted: true,
      hasExplicitToken: Boolean(process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN || process.env.HF_ACCESS_TOKEN),
      hfUserCount: envParsed.tokens.length,
      allowPublic: envFlag('HF_LOG_ALLOW_PUBLIC', false)
    });
  });

  router.get('/api/openclaw/spaces/:owner/:name/logs/run', loginGuard, async (req, res) => {
    const repoId = sanitizeRepoId(`${req.params.owner}/${req.params.name}`);
    if (!repoId) return res.status(400).json({ error: 'Invalid repoId. Use owner/name.' });

    const hfToken = pickHfToken(req, repoId, options);
    if (!hfToken) {
      return res.status(500).json({
        error: 'No Hugging Face token found. Set HF_TOKEN=hf_xxx or HF_USER="username:hf_xxx".'
      });
    }

    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();

    let closed = false;
    req.on('close', () => { closed = true; });

    writeSse(res, 'open', { repoId, message: 'HF log stream connected' });

    try {
      const hfResp = await axios.get(hfLogsUrl(repoId), {
        responseType: 'stream',
        timeout: 0,
        headers: {
          Authorization: `Bearer ${hfToken}`,
          Accept: 'text/plain, */*',
          'User-Agent': 'hflog-openclaw-logs/2.0'
        },
        validateStatus: () => true
      });

      if (hfResp.status < 200 || hfResp.status >= 300) {
        let body = '';
        hfResp.data.on('data', chunk => { body += chunk.toString('utf8'); });
        hfResp.data.on('end', () => {
          writeSse(res, 'error', { status: hfResp.status, body: body.slice(0, 2000) });
          res.end();
        });
        return;
      }

      let buffer = '';
      let recent = '';
      const heartbeat = setInterval(() => writeSse(res, 'ping', { ts: Date.now() }), 25000);

      hfResp.data.on('data', chunk => {
        if (closed) return;
        const text = chunk.toString('utf8');
        buffer += text;
        recent = (recent + text).slice(-30000);

        const links = extractWechatLinks(text);
        if (links.length) writeSse(res, 'wechat-link', { repoId, links });

        const blocks = extractQrBlock(recent);
        if (blocks.length) writeSse(res, 'wechat-qr', { repoId, blocks });

        const parts = buffer.split(/\r?\n/);
        buffer = parts.pop() || '';
        for (const line of parts) writeSse(res, 'log', { repoId, line });
      });

      hfResp.data.on('end', () => {
        clearInterval(heartbeat);
        if (buffer) writeSse(res, 'log', { repoId, line: buffer });
        writeSse(res, 'close', { repoId, message: 'HF log stream ended' });
        res.end();
      });

      hfResp.data.on('error', err => {
        clearInterval(heartbeat);
        writeSse(res, 'error', { message: err.message || String(err) });
        res.end();
      });
    } catch (err) {
      writeSse(res, 'error', { message: err.message || String(err) });
      res.end();
    }
  });

  router.get('/api/openclaw/spaces/:owner/:name/logs/snapshot', loginGuard, async (req, res) => {
    const repoId = sanitizeRepoId(`${req.params.owner}/${req.params.name}`);
    if (!repoId) return res.status(400).json({ error: 'Invalid repoId. Use owner/name.' });

    const hfToken = pickHfToken(req, repoId, options);
    if (!hfToken) {
      return res.status(500).json({
        error: 'No Hugging Face token found. Set HF_TOKEN=hf_xxx or HF_USER="username:hf_xxx".'
      });
    }

    try {
      const hfResp = await axios.get(hfLogsUrl(repoId), {
        responseType: 'text',
        timeout: Number(process.env.HF_LOG_SNAPSHOT_TIMEOUT_MS || 15000),
        headers: {
          Authorization: `Bearer ${hfToken}`,
          Accept: 'text/plain, */*',
          'User-Agent': 'hflog-openclaw-logs/2.0'
        },
        validateStatus: () => true
      });

      const text = String(hfResp.data || '');
      res.status(hfResp.status).json({
        repoId,
        status: hfResp.status,
        text: text.slice(-50000),
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
