(function () {
  'use strict';

  const DEFAULT_MAX_LINES = 1000;

  function getAuthHeaders() {
    const keys = ['authToken', 'token', 'hfManagerToken', 'adminToken'];
    for (const key of keys) {
      const value = localStorage.getItem(key) || sessionStorage.getItem(key);
      if (value) return { Authorization: `Bearer ${value}` };
    }
    return {};
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[c]));
  }

  function normalizeRepoId(value) {
    value = String(value || '').trim();
    if (!value && window.OPENCLAW_DEFAULT_SPACE) value = window.OPENCLAW_DEFAULT_SPACE;
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)) return '';
    return value;
  }

  function apiBase(repoId, path) {
    const [owner, name] = repoId.split('/');
    return `/api/openclaw/spaces/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/logs/${path}`;
  }

  async function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }

  function parseSseChunk(buffer, onEvent) {
    const chunks = buffer.split(/\n\n/);
    const rest = chunks.pop() || '';

    for (const raw of chunks) {
      let event = 'message';
      const dataLines = [];
      raw.split(/\n/).forEach(line => {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
      });
      const dataRaw = dataLines.join('\n');
      if (!dataRaw) continue;
      try {
        onEvent(event, JSON.parse(dataRaw));
      } catch (_) {
        onEvent(event, { raw: dataRaw });
      }
    }

    return rest;
  }

  class OpenClawLogPanel {
    constructor(root) {
      this.root = root;
      this.abortController = null;
      this.lines = [];
      this.lastLinks = [];
      this.lastQrBlocks = [];
      this.maxLines = Number(root.dataset.maxLines || DEFAULT_MAX_LINES);
      this.render();
    }

    render() {
      this.root.classList.add('oc-log-panel');
      this.root.innerHTML = `
        <div class="oc-log-head">
          <div>
            <div class="oc-log-title">OpenClaw 微信登录日志</div>
            <div class="oc-log-subtitle">后端代理 Hugging Face Logs；支持一个 HF 账号下多个 Space 实例。</div>
          </div>
          <div class="oc-log-form">
            <input class="oc-repo" placeholder="owner/space，例如 mistaxx/claw" />
            <button class="oc-connect" type="button">连接日志</button>
            <button class="oc-stop" type="button" disabled>停止</button>
            <button class="oc-snapshot" type="button">抓取快照</button>
          </div>
        </div>
        <div class="oc-log-status">未连接</div>
        <div class="oc-log-links"></div>
        <pre class="oc-log-output"></pre>
      `;

      this.repoInput = this.root.querySelector('.oc-repo');
      this.connectBtn = this.root.querySelector('.oc-connect');
      this.stopBtn = this.root.querySelector('.oc-stop');
      this.snapshotBtn = this.root.querySelector('.oc-snapshot');
      this.statusEl = this.root.querySelector('.oc-log-status');
      this.linksEl = this.root.querySelector('.oc-log-links');
      this.outputEl = this.root.querySelector('.oc-log-output');

      this.repoInput.value = this.root.dataset.repoId || window.OPENCLAW_DEFAULT_SPACE || '';
      this.connectBtn.addEventListener('click', () => this.connect());
      this.stopBtn.addEventListener('click', () => this.stop('已停止'));
      this.snapshotBtn.addEventListener('click', () => this.snapshot());
    }

    setStatus(text) {
      this.statusEl.textContent = text;
    }

    addLine(line) {
      this.lines.push(line);
      if (this.lines.length > this.maxLines) this.lines.splice(0, this.lines.length - this.maxLines);
      this.outputEl.textContent = this.lines.join('\n');
      this.outputEl.scrollTop = this.outputEl.scrollHeight;
    }

    showWechat(data) {
      if (data.links) this.lastLinks = Array.from(new Set(this.lastLinks.concat(data.links)));
      if (data.blocks) this.lastQrBlocks = data.blocks;

      const linkHtml = this.lastLinks.map((link, i) => `
        <div class="oc-wechat-link">
          <span>微信扫码链接 ${i + 1}</span>
          <a href="${escapeHtml(link)}" target="_blank" rel="noreferrer">打开</a>
          <button type="button" data-copy="${escapeHtml(link)}">复制</button>
        </div>
      `).join('');

      const qrHtml = this.lastQrBlocks.map(block => `
        <pre class="oc-wechat-qr">${escapeHtml(block)}</pre>
      `).join('');

      this.linksEl.innerHTML = linkHtml + qrHtml;
      this.linksEl.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await copyText(btn.getAttribute('data-copy'));
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制'; }, 1200);
        });
      });
    }

    handleEvent(event, data) {
      if (event === 'open') {
        this.setStatus(`已连接 ${data.repoId || ''}`);
        this.addLine(`[open] ${data.message || ''}`);
      } else if (event === 'log') {
        this.addLine(data.line || '');
      } else if (event === 'wechat-link') {
        this.showWechat({ links: data.links || [] });
      } else if (event === 'wechat-qr') {
        this.showWechat({ blocks: data.blocks || [] });
      } else if (event === 'error') {
        const msg = data.message || data.error || data.body || `HTTP ${data.status || ''}`;
        this.setStatus(`日志连接错误：${msg}`);
        this.addLine(`[error] ${msg}`);
      } else if (event === 'close') {
        this.stop('HF 日志流已结束');
      }
    }

    async connect() {
      const repoId = normalizeRepoId(this.repoInput.value);
      if (!repoId) return this.setStatus('请输入正确的 Space：owner/name');

      this.stop();
      this.lines = [];
      this.lastLinks = [];
      this.lastQrBlocks = [];
      this.outputEl.textContent = '';
      this.linksEl.innerHTML = '';
      this.setStatus(`正在连接 ${repoId} ...`);
      this.connectBtn.disabled = true;
      this.stopBtn.disabled = false;

      this.abortController = new AbortController();

      try {
        const resp = await fetch(apiBase(repoId, 'run'), {
          headers: getAuthHeaders(),
          signal: this.abortController.signal
        });

        if (!resp.ok) {
          let text = await resp.text();
          try { text = JSON.parse(text).error || text; } catch (_) {}
          throw new Error(`HTTP ${resp.status}: ${text}`);
        }

        if (!resp.body || !resp.body.getReader) throw new Error('当前浏览器不支持流式日志读取');

        const reader = resp.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';

        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
          buffer = parseSseChunk(buffer, (event, data) => this.handleEvent(event, data));
        }

        if (buffer.trim()) parseSseChunk(buffer + '\n\n', (event, data) => this.handleEvent(event, data));
        this.stop('HF 日志流已结束');
      } catch (err) {
        if (err.name === 'AbortError') return;
        this.setStatus(err.message || String(err));
        this.addLine(`[error] ${err.message || String(err)}`);
        this.stop();
      }
    }

    stop(message) {
      if (this.abortController) this.abortController.abort();
      this.abortController = null;
      if (this.connectBtn) this.connectBtn.disabled = false;
      if (this.stopBtn) this.stopBtn.disabled = true;
      if (message) this.setStatus(message);
    }

    async snapshot() {
      const repoId = normalizeRepoId(this.repoInput.value);
      if (!repoId) return this.setStatus('请输入正确的 Space：owner/name');

      this.setStatus(`正在抓取 ${repoId} 日志快照 ...`);
      try {
        const resp = await fetch(apiBase(repoId, 'snapshot'), { headers: getAuthHeaders() });
        const data = await resp.json();
        if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);

        this.lines = String(data.text || '').split(/\r?\n/).slice(-this.maxLines);
        this.outputEl.textContent = this.lines.join('\n');
        this.outputEl.scrollTop = this.outputEl.scrollHeight;
        this.showWechat({ links: data.wechatLinks || [], blocks: data.qrBlocks || [] });
        this.setStatus(`已抓取 ${repoId} 日志快照`);
      } catch (err) {
        this.setStatus(err.message || String(err));
      }
    }
  }

  window.OpenClawLogPanel = OpenClawLogPanel;

  function boot() {
    document.querySelectorAll('[data-openclaw-logs]').forEach(el => {
      if (!el.__ocLogPanel) el.__ocLogPanel = new OpenClawLogPanel(el);
    });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
