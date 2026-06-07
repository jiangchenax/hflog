(function () {
  'use strict';

  const DEFAULT_MAX_LINES = 800;

  function getAuthHeaders() {
    const token = localStorage.getItem('authToken') || localStorage.getItem('token') || sessionStorage.getItem('authToken') || '';
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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

  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text);
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    return Promise.resolve();
  }

  class OpenClawLogPanel {
    constructor(root) {
      this.root = root;
      this.es = null;
      this.lines = [];
      this.lastLinks = [];
      this.lastQrBlocks = [];
      this.maxLines = Number(root.dataset.maxLines || DEFAULT_MAX_LINES);
      this.render();
    }

    render() {
      this.root.innerHTML = `
        <section class="oc-log-panel">
          <div class="oc-log-head">
            <div>
              <div class="oc-log-title">OpenClaw 微信登录日志</div>
              <div class="oc-log-subtitle">后端代理 Hugging Face Logs，不暴露 HF_TOKEN；支持一个账号下多个运行实例。</div>
            </div>
            <div class="oc-log-form">
              <input class="oc-repo" placeholder="owner/space，例如 mistaxx/claw" />
              <button class="oc-connect">连接日志</button>
              <button class="oc-stop" disabled>停止</button>
              <button class="oc-snapshot">抓取快照</button>
            </div>
          </div>
          <div class="oc-log-status">未连接</div>
          <div class="oc-log-links"></div>
          <pre class="oc-log-output"></pre>
        </section>
      `;
      this.repoInput = this.root.querySelector('.oc-repo');
      this.connectBtn = this.root.querySelector('.oc-connect');
      this.stopBtn = this.root.querySelector('.oc-stop');
      this.snapshotBtn = this.root.querySelector('.oc-snapshot');
      this.statusEl = this.root.querySelector('.oc-log-status');
      this.linksEl = this.root.querySelector('.oc-log-links');
      this.outputEl = this.root.querySelector('.oc-log-output');

      const preset = this.root.dataset.repoId || window.OPENCLAW_DEFAULT_SPACE || '';
      this.repoInput.value = preset;

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
          <a href="${escapeHtml(link)}" target="_blank" rel="noopener noreferrer">打开</a>
          <button data-copy="${escapeHtml(link)}">复制</button>
        </div>`).join('');

      const qrHtml = this.lastQrBlocks.map(block => `<pre class="oc-wechat-qr">${escapeHtml(block)}</pre>`).join('');
      this.linksEl.innerHTML = linkHtml + qrHtml;
      this.linksEl.querySelectorAll('[data-copy]').forEach(btn => {
        btn.addEventListener('click', async () => {
          await copy(btn.getAttribute('data-copy'));
          btn.textContent = '已复制';
          setTimeout(() => { btn.textContent = '复制'; }, 1200);
        });
      });
    }

    connect() {
      const repoId = normalizeRepoId(this.repoInput.value);
      if (!repoId) {
        this.setStatus('请输入正确的 Space：owner/name');
        return;
      }
      this.stop();
      this.lines = [];
      this.lastLinks = [];
      this.lastQrBlocks = [];
      this.outputEl.textContent = '';
      this.linksEl.innerHTML = '';
      this.setStatus(`正在连接 ${repoId} ...`);

      // EventSource cannot set Authorization header. If your manager requires login,
      // set HF_LOG_ALLOW_PUBLIC=1 for this read-only SSE route, or use same-site cookie auth.
      const url = apiBase(repoId, 'run');
      this.es = new EventSource(url);
      this.connectBtn.disabled = true;
      this.stopBtn.disabled = false;

      this.es.addEventListener('open', ev => {
        this.setStatus(`已连接 ${repoId}`);
        try { this.addLine(`[open] ${JSON.parse(ev.data).message || ''}`); } catch (_) {}
      });
      this.es.addEventListener('log', ev => {
        const data = JSON.parse(ev.data);
        this.addLine(data.line || '');
      });
      this.es.addEventListener('wechat-link', ev => {
        const data = JSON.parse(ev.data);
        this.showWechat({ links: data.links || [] });
      });
      this.es.addEventListener('wechat-qr', ev => {
        const data = JSON.parse(ev.data);
        this.showWechat({ blocks: data.blocks || [] });
      });
      this.es.addEventListener('error', ev => {
        let msg = '日志连接出错，可能是 Space 不存在、token 权限不足或接口被登录保护。';
        try { msg = JSON.parse(ev.data).message || msg; } catch (_) {}
        this.setStatus(msg);
        this.addLine(`[error] ${msg}`);
      });
      this.es.addEventListener('close', () => this.stop('HF 日志流已结束'));
    }

    stop(message) {
      if (this.es) this.es.close();
      this.es = null;
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
