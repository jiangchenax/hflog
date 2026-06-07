# OpenClaw HF Logs Integration for hf-space-manager

这个压缩包用于把 Hugging Face Space 的运行日志接入你的 `hf-space-manager` 管理页面，并自动提取 OpenClaw 微信扫码登录链接：

```text
https://liteapp.weixin.qq.com/q/...
```

适配场景：一个 Hugging Face 账号 token 管理多个 Space / 多个 OpenClaw 运行实例。

## 文件

```text
server.openclaw-logs.js              后端 Express 路由，代理 HF Logs，保护 HF_TOKEN
public/openclaw-logs-panel.js        前端日志面板组件
public/openclaw-logs-panel.css       面板样式
public/openclaw-logs.html            独立日志页面示例
install-openclaw-logs.sh             自动安装/注入脚本
```

## 一键安装

把压缩包解压到你的 `hf-space-manager` 项目根目录：

```bash
unzip openclaw-hf-logs-integration.zip -d openclaw-hf-logs-integration
cp -r openclaw-hf-logs-integration/* /path/to/hf-space-manager/
cd /path/to/hf-space-manager
bash install-openclaw-logs.sh .
```

然后设置环境变量：

```bash
export HF_TOKEN="hf_xxx"
# 如果 SSE 被登录拦截，开启这个。注意只读日志也可能包含敏感信息。
export HF_LOG_ALLOW_PUBLIC=1
npm start
```

打开：

```text
/openclaw-logs.html
```

输入你的 Space：

```text
mistaxx/claw
```

即可看到日志流和自动提取出的微信扫码链接。

## 嵌入现有页面

在任意 HTML 位置放：

```html
<link rel="stylesheet" href="/openclaw-logs-panel.css">
<div data-openclaw-logs data-repo-id="mistaxx/claw"></div>
<script src="/openclaw-logs-panel.js"></script>
```

多个实例可以放多个容器：

```html
<div data-openclaw-logs data-repo-id="mistaxx/claw"></div>
<div data-openclaw-logs data-repo-id="mistaxx/openclaw2"></div>
<div data-openclaw-logs data-repo-id="mistaxx/openclaw3"></div>
```

## 手动接入 server.js

如果不使用安装脚本，在 `server.js` 里加入：

```js
const openclawLogs = require('./server.openclaw-logs');

app.use(openclawLogs({
  requireLogin: typeof requireLogin === 'function' ? requireLogin : undefined,
  sessionTokens: typeof sessionTokens !== 'undefined' ? sessionTokens : undefined
}));
```

## API

实时日志 SSE：

```text
GET /api/openclaw/spaces/:owner/:name/logs/run
```

快照：

```text
GET /api/openclaw/spaces/:owner/:name/logs/snapshot
```

后端实际请求 Hugging Face：

```bash
curl -N \
  -H "Authorization: Bearer $HF_TOKEN" \
  "https://huggingface.co/api/spaces/mistaxx/claw/logs/run"
```

## 注意

1. `HF_TOKEN` 必须只放后端环境变量，不要放前端。
2. 一个 HF token 可管理多个 Space，只要 token 有这些 Space 的访问权限。
3. EventSource 不能自定义 Authorization header；如果你的原项目登录中间件只认 Bearer header，实时 SSE 可能 401。此时设置 `HF_LOG_ALLOW_PUBLIC=1`，或把项目改成 cookie 登录。
4. 日志里可能包含二维码和运行信息，不建议在公网无登录暴露。
