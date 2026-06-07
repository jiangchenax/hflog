# hflog OpenClaw Logs Fix v2

这个包修复“部署后管理页面没有 log”的问题。

## 你现在仓库里的主要问题

1. `server.openclaw-logs.js` 文件存在，但 `server.js` 没有 `require('./server.openclaw-logs')`，也没有 `app.use(openclawLogs(...))`。
2. `public/openclaw-logs-panel.js` 文件存在，但 `public/index.html` 没有加载 CSS/JS，也没有 `<div data-openclaw-logs>` 容器。
3. 原安装脚本如果把日志路由挂在 `app.get('*')` 后面，`/api/openclaw/*` 会被前端 catch-all 吃掉，返回 `index.html`，所以接口不可用。
4. 原日志模块只读 `HF_TOKEN`，但你的管理器主要使用 `HF_USER="username:token"`。v2 已支持 `HF_USER`。
5. 原前端用 `EventSource`，不能发送 `Authorization` header。v2 改成 `fetch` 流式读取，可以携带登录 token。

## 安装

在仓库根目录执行：

```bash
unzip hflog-openclaw-log-fix-v2.zip
cp -r hflog-openclaw-log-fix-v2/* .
bash install-hflog-openclaw-logs.sh .
```

提交并部署：

```bash
git add .
git commit -m "fix openclaw hf logs panel"
git push
```

## 环境变量

一个 Hugging Face 账号管理多个 Space 实例时：

```bash
HF_USER="your_hf_username:hf_xxx"
```

也可以用：

```bash
HF_TOKEN="hf_xxx"
```

## 测试

部署后打开：

```text
/api/openclaw/health
```

应该返回：

```json
{"ok":true,"mounted":true,...}
```

然后打开：

```text
/openclaw-logs.html
```

输入 Space：

```text
owner/space
```

例如：

```text
mistaxx/claw
```

如果 OpenClaw 正在输出微信扫码日志，页面会自动显示二维码文本和 `https://liteapp.weixin.qq.com/q/...` 链接。

## 管理页嵌入

安装脚本会自动向 `public/index.html` 注入：

```html
<link rel="stylesheet" href="/openclaw-logs-panel.css">
<div data-openclaw-logs></div>
<script src="/openclaw-logs-panel.js"></script>
```

你也可以把 `<div data-openclaw-logs></div>` 移动到每个 Space 卡片附近。
