#!/usr/bin/env bash
set -euo pipefail

ROOT="${1:-.}"
cd "$ROOT"

if [ ! -f server.js ]; then
  echo "[ERROR] server.js not found. Run this script in hf-space-manager project root." >&2
  exit 1
fi
if [ ! -d public ]; then
  mkdir -p public
fi

cp server.openclaw-logs.js ./server.openclaw-logs.js
cp public/openclaw-logs-panel.js ./public/openclaw-logs-panel.js
cp public/openclaw-logs-panel.css ./public/openclaw-logs-panel.css
cp public/openclaw-logs.html ./public/openclaw-logs.html

if ! grep -q "server.openclaw-logs" server.js; then
  python3 - <<'PY'
from pathlib import Path
p = Path('server.js')
s = p.read_text(encoding='utf-8')
insert = "\n// OpenClaw Hugging Face log stream proxy\nconst openclawLogs = require('./server.openclaw-logs');\n"
# Put require near other require statements.
lines = s.splitlines(True)
pos = 0
for i, line in enumerate(lines):
    if line.strip().startswith('const ') and 'require(' in line:
        pos = i + 1
lines.insert(pos, insert)
s = ''.join(lines)
mount = "\n// Mount OpenClaw log API. Pass existing auth helpers when available.\napp.use(openclawLogs({\n  requireLogin: typeof requireLogin === 'function' ? requireLogin : undefined,\n  sessionTokens: typeof sessionTokens !== 'undefined' ? sessionTokens : undefined\n}));\n"
# Mount after app is defined and after express.static if possible, before listen.
idx = s.find('app.listen(')
if idx == -1:
    idx = len(s)
s = s[:idx] + mount + s[idx:]
p.write_text(s, encoding='utf-8')
PY
  echo "[OK] server.js patched"
else
  echo "[SKIP] server.js already patched"
fi

if [ -f public/index.html ] && ! grep -q "openclaw-logs-panel.js" public/index.html; then
  python3 - <<'PY'
from pathlib import Path
p = Path('public/index.html')
s = p.read_text(encoding='utf-8')
css = '  <link rel="stylesheet" href="/openclaw-logs-panel.css">\n'
js = '  <script src="/openclaw-logs-panel.js"></script>\n'
# Add a floating embeddable panel container before body end.
panel = '''\n  <!-- OpenClaw 微信扫码日志面板：可移动到你想展示的位置 -->\n  <div data-openclaw-logs data-repo-id="mistaxx/claw"></div>\n'''
if '</head>' in s:
    s = s.replace('</head>', css + '</head>', 1)
if '</body>' in s:
    s = s.replace('</body>', panel + js + '</body>', 1)
else:
    s += panel + js
p.write_text(s, encoding='utf-8')
PY
  echo "[OK] public/index.html injected"
else
  echo "[SKIP] public/index.html missing or already injected"
fi

cat <<'MSG'

Done.

Required env:
  HF_TOKEN=hf_xxx

If your EventSource route returns 401 because browser EventSource cannot send Authorization headers, set:
  HF_LOG_ALLOW_PUBLIC=1
This only exposes the read-only backend log proxy to users who can access your manager site. Keep your manager behind login or private network if logs are sensitive.

Open:
  /openclaw-logs.html
or use the embedded panel in /index.html.

Change default Space in HTML from mistaxx/claw to your actual owner/space.
MSG
