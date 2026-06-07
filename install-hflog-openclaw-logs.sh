#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

if [ ! -f server.js ]; then
  echo "[ERROR] server.js not found. Run this script in hflog / hf-space-manager project root." >&2
  exit 1
fi

mkdir -p public
cp server.openclaw-logs.js ./server.openclaw-logs.js
cp public/openclaw-logs-panel.js ./public/openclaw-logs-panel.js
cp public/openclaw-logs-panel.css ./public/openclaw-logs-panel.css
cp public/openclaw-logs.html ./public/openclaw-logs.html

python3 - <<'PY'
from pathlib import Path

p = Path('server.js')
s = p.read_text(encoding='utf-8')

require_line = "const openclawLogs = require('./server.openclaw-logs');"
if require_line not in s:
    marker = 'const app = express();'
    if marker in s:
        s = s.replace(marker, marker + "\n" + require_line, 1)
    else:
        s = require_line + "\n" + s

mount_marker = '// OPENCLAW_LOG_PROXY_MOUNT_V2'
mount = """
// OPENCLAW_LOG_PROXY_MOUNT_V2
app.use(openclawLogs({
  requireLogin: typeof authenticateToken === 'function'
    ? authenticateToken
    : (typeof requireLogin === 'function' ? requireLogin : undefined),
  sessions: typeof sessions !== 'undefined' ? sessions : undefined,
  sessionTokens: typeof sessionTokens !== 'undefined' ? sessionTokens : undefined,
  userTokenMapping: typeof userTokenMapping !== 'undefined' ? userTokenMapping : undefined
}));
"""

if mount_marker not in s:
    # Very important: mount BEFORE the SPA catch-all route, otherwise /api/openclaw/* returns index.html.
    targets = [
        "// 处理其他请求，重定向到 index.html",
        "app.get('*'",
        'app.get("*"',
        'app.listen('
    ]
    pos = -1
    for t in targets:
        pos = s.find(t)
        if pos != -1:
            break
    if pos == -1:
        s += "\n" + mount
    else:
        s = s[:pos] + mount + "\n" + s[pos:]

p.write_text(s, encoding='utf-8')
print('[OK] server.js patched: require + route mounted before catch-all')
PY

if [ -f public/index.html ]; then
  python3 - <<'PY'
from pathlib import Path
p = Path('public/index.html')
s = p.read_text(encoding='utf-8')

css = '<link rel="stylesheet" href="/openclaw-logs-panel.css">'
js = '<script src="/openclaw-logs-panel.js"></script>'
panel = '''
<!-- OpenClaw 微信扫码日志面板：可移动到你想显示的位置 -->
<section id="openclaw-log-section" style="margin:16px 0;">
  <div data-openclaw-logs></div>
</section>
'''

if 'openclaw-logs-panel.css' not in s:
    if '</head>' in s:
        s = s.replace('</head>', '  ' + css + '\n</head>', 1)
    else:
        s = css + '\n' + s

if 'data-openclaw-logs' not in s:
    if '</body>' in s:
        s = s.replace('</body>', panel + '\n</body>', 1)
    else:
        s += '\n' + panel

if 'openclaw-logs-panel.js' not in s:
    if '</body>' in s:
        s = s.replace('</body>', '  ' + js + '\n</body>', 1)
    else:
        s += '\n' + js + '\n'

p.write_text(s, encoding='utf-8')
print('[OK] public/index.html patched: panel + css/js injected')
PY
else
  echo "[WARN] public/index.html not found, standalone /openclaw-logs.html still works."
fi

cat <<'MSG'

Done.

Required env for your one HF account with multiple instances:
  HF_USER="your_hf_username:hf_xxx"

Alternative:
  HF_TOKEN="hf_xxx"

Then restart/redeploy and test:
  /api/openclaw/health
  /openclaw-logs.html

On the log page, enter a Space repo id like:
  mistaxx/claw

MSG
