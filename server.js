const express = require('express');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const crypto = require('crypto');
const app = express();
const openclawLogs = require('./server.openclaw-logs');
const port = process.env.PORT || 8080;

// ==================== 日志系统 ====================
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };
const currentLogLevel = LOG_LEVELS[process.env.LOG_LEVEL] ?? LOG_LEVELS.info;

function formatTimestamp() {
  return new Date().toISOString();
}

const logger = {
  error: (msg, ...args) => {
    if (currentLogLevel >= LOG_LEVELS.error) {
      console.error(`[${formatTimestamp()}] [ERROR] ${msg}`, ...args);
    }
  },
  warn: (msg, ...args) => {
    if (currentLogLevel >= LOG_LEVELS.warn) {
      console.warn(`[${formatTimestamp()}] [WARN] ${msg}`, ...args);
    }
  },
  info: (msg, ...args) => {
    if (currentLogLevel >= LOG_LEVELS.info) {
      console.log(`[${formatTimestamp()}] [INFO] ${msg}`, ...args);
    }
  },
  debug: (msg, ...args) => {
    if (currentLogLevel >= LOG_LEVELS.debug) {
      console.log(`[${formatTimestamp()}] [DEBUG] ${msg}`, ...args);
    }
  }
};

// ==================== 持久化存储 ====================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    logger.info(`创建数据目录: ${DATA_DIR}`);
  }
}

function loadPersistedConfig() {
  try {
    ensureDataDir();
    if (fs.existsSync(CONFIG_FILE)) {
      const data = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      logger.info('已加载持久化配置');
      return data;
    }
  } catch (error) {
    logger.error('加载持久化配置失败:', error.message);
  }
  return { scheduledRestarts: {}, keepAliveConfigs: {}, globalKeepAlive: null };
}

function savePersistedConfig() {
  try {
    ensureDataDir();
    const data = {
      scheduledRestarts: Object.fromEntries(
        [...scheduledRestarts.entries()].map(([k, v]) => [k, { enabled: v.enabled, intervalHours: v.intervalHours }])
      ),
      keepAliveConfigs: Object.fromEntries(
        [...keepAliveConfigs.entries()].map(([k, v]) => [k, { enabled: v.enabled, intervalMinutes: v.intervalMinutes }])
      ),
      globalKeepAlive: { enabled: globalKeepAlive.enabled, intervalMinutes: globalKeepAlive.intervalMinutes }
    };
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(data, null, 2));
    logger.debug('持久化配置已保存');
  } catch (error) {
    logger.error('保存持久化配置失败:', error.message);
  }
}

// ==================== Rate Limiting ====================
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 分钟
const RATE_LIMIT_MAX = parseInt(process.env.RATE_LIMIT_MAX) || 100; // 每分钟最大请求数

function rateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  
  if (!rateLimitMap.has(ip)) {
    rateLimitMap.set(ip, { count: 1, startTime: now });
    return next();
  }
  
  const record = rateLimitMap.get(ip);
  if (now - record.startTime > RATE_LIMIT_WINDOW) {
    record.count = 1;
    record.startTime = now;
    return next();
  }
  
  record.count++;
  if (record.count > RATE_LIMIT_MAX) {
    logger.warn(`Rate limit exceeded for IP: ${ip}`);
    return res.status(429).json({ error: '请求过于频繁，请稍后再试' });
  }
  
  next();
}

// 定期清理过期的 rate limit 记录
setInterval(() => {
  const now = Date.now();
  for (const [ip, record] of rateLimitMap.entries()) {
    if (now - record.startTime > RATE_LIMIT_WINDOW * 2) {
      rateLimitMap.delete(ip);
    }
  }
}, RATE_LIMIT_WINDOW);

// 启用 JSON 和 URL-encoded 请求解析
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(rateLimiter);

// 从环境变量获取 HuggingFace 用户名和对应的 API Token 映射
const userTokenMapping = {};
const usernames = [];
const hfUserConfig = process.env.HF_USER || '';
if (hfUserConfig) {
  hfUserConfig.split(',').forEach(pair => {
    const parts = pair.split(':').map(part => part.trim());
    const username = parts[0];
    const token = parts[1] || '';
    if (username) {
      usernames.push(username);
      if (token) {
        userTokenMapping[username] = token;
      }
    }
  });
}

// 从环境变量获取登录凭据
const ADMIN_USERNAME = process.env.USER_NAME || 'admin';
const ADMIN_PASSWORD = process.env.USER_PASSWORD || 'password';

// 从环境变量获取是否在未登录时展示 private 实例的配置，默认值为 false
const SHOW_PRIVATE = process.env.SHOW_PRIVATE === 'true';
logger.info(`SHOW_PRIVATE 配置: ${SHOW_PRIVATE ? '未登录时展示 private 实例' : '未登录时隐藏 private 实例'}`);

// 存储会话 token 的简单内存数据库（生产环境中应使用数据库或 Redis）
const sessions = new Map();
const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24小时超时

// 定时重启配置存储
const scheduledRestarts = new Map(); // key: repoId, value: { enabled: boolean, intervalHours: number, lastRestart: Date, timerId: number }

// 保活配置存储
const keepAliveConfigs = new Map(); // key: repoId, value: { enabled: boolean, intervalMinutes: number, lastPing: Date, timerId: number }

// 全局保活开关
let globalKeepAlive = {
  enabled: false,
  intervalMinutes: 30,
  timerId: null
};

// 缓存管理
class SpaceCache {
  constructor() {
    this.spaces = {};
    this.lastUpdate = null;
  }

  updateAll(spacesData) {
    this.spaces = spacesData.reduce((acc, space) => ({ ...acc, [space.repo_id]: space }), {});
    this.lastUpdate = Date.now();
  }

  getAll() {
    return Object.values(this.spaces);
  }

  isExpired(expireMinutes = 5) {
    if (!this.lastUpdate) return true;
    return (Date.now() - this.lastUpdate) > (expireMinutes * 60 * 1000);
  }

  invalidate() {
    this.lastUpdate = null;
  }
}

const spaceCache = new SpaceCache();

// 执行定时重启
async function executeScheduledRestart(repoId) {
  const config = scheduledRestarts.get(repoId);
  if (!config || !config.enabled) return;

  const spaces = spaceCache.getAll();
  const space = spaces.find(s => s.repo_id === repoId);
  if (!space) {
    logger.error(`定时重启失败: Space ${repoId} 未找到`);
    return;
  }

  const token = userTokenMapping[space.username];
  if (!token) {
    logger.error(`定时重启失败: Space ${repoId} 无 Token 配置`);
    return;
  }

  try {
    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    await axios.post(`https://huggingface.co/api/spaces/${repoId}/restart`, {}, { headers });
    config.lastRestart = new Date();
    logger.info(`定时重启成功: ${repoId}`);
  } catch (error) {
    logger.error(`定时重启失败 (${repoId}):`, error.message);
  }
}

// 设置定时重启
function setScheduledRestart(repoId, intervalHours, enabled = true) {
  // 清除现有定时器
  const existing = scheduledRestarts.get(repoId);
  if (existing && existing.timerId) {
    clearInterval(existing.timerId);
  }

  if (!enabled) {
    scheduledRestarts.delete(repoId);
    logger.info(`已禁用定时重启: ${repoId}`);
    savePersistedConfig();
    return;
  }

  const intervalMs = intervalHours * 60 * 60 * 1000;
  const timerId = setInterval(() => executeScheduledRestart(repoId), intervalMs);

  scheduledRestarts.set(repoId, {
    enabled: true,
    intervalHours,
    lastRestart: null,
    timerId
  });

  logger.info(`已设置定时重启: ${repoId}, 间隔 ${intervalHours} 小时`);
  savePersistedConfig();
}

// 执行保活 ping
async function executeKeepAlivePing(repoId) {
  const spaces = spaceCache.getAll();
  const space = spaces.find(s => s.repo_id === repoId);
  if (!space) {
    logger.info(`保活 ping 跳过: Space ${repoId} 未找到`);
    return;
  }

  try {
    const url = space.url;
    await axios.get(url, { timeout: 30000 });
    const config = keepAliveConfigs.get(repoId);
    if (config) {
      config.lastPing = new Date();
    }
    logger.info(`保活 ping 成功: ${repoId} -> ${url}`);
  } catch (error) {
    logger.info(`保活 ping 失败 (${repoId}): ${error.message}`);
  }
}

// 设置单个实例保活
function setKeepAlive(repoId, intervalMinutes, enabled = true) {
  // 清除现有定时器
  const existing = keepAliveConfigs.get(repoId);
  if (existing && existing.timerId) {
    clearInterval(existing.timerId);
  }

  if (!enabled) {
    keepAliveConfigs.delete(repoId);
    logger.info(`已禁用保活: ${repoId}`);
    savePersistedConfig();
    return;
  }

  const intervalMs = intervalMinutes * 60 * 1000;
  const timerId = setInterval(() => executeKeepAlivePing(repoId), intervalMs);

  // 立即执行一次
  executeKeepAlivePing(repoId);

  keepAliveConfigs.set(repoId, {
    enabled: true,
    intervalMinutes,
    lastPing: new Date(),
    timerId
  });

  logger.info(`已设置保活: ${repoId}, 间隔 ${intervalMinutes} 分钟`);
  savePersistedConfig();
}

// 全局保活 - ping 所有运行中的实例
async function executeGlobalKeepAlive() {
  if (!globalKeepAlive.enabled) return;

  const spaces = spaceCache.getAll();
  const runningSpaces = spaces.filter(s => s.status.toLowerCase() === 'running' || s.status.toLowerCase() === 'sleeping');

  logger.info(`全局保活开始: 共 ${runningSpaces.length} 个实例`);

  for (const space of runningSpaces) {
    try {
      await axios.get(space.url, { timeout: 30000 });
      logger.info(`全局保活 ping 成功: ${space.repo_id}`);
    } catch (error) {
      logger.info(`全局保活 ping 失败 (${space.repo_id}): ${error.message}`);
    }
    // 间隔 5 秒避免请求过快
    await new Promise(resolve => setTimeout(resolve, 5000));
  }

  logger.info(`全局保活完成`);
}

// 设置全局保活
function setGlobalKeepAlive(intervalMinutes, enabled = true) {
  if (globalKeepAlive.timerId) {
    clearInterval(globalKeepAlive.timerId);
    globalKeepAlive.timerId = null;
  }

  globalKeepAlive.enabled = enabled;
  globalKeepAlive.intervalMinutes = intervalMinutes;

  if (enabled) {
    const intervalMs = intervalMinutes * 60 * 1000;
    globalKeepAlive.timerId = setInterval(executeGlobalKeepAlive, intervalMs);
    // 立即执行一次
    executeGlobalKeepAlive();
    logger.info(`已启用全局保活, 间隔 ${intervalMinutes} 分钟`);
  } else {
    logger.info(`已禁用全局保活`);
  }
  savePersistedConfig();
}

// 用于获取 Spaces 数据的函数，带有重试机制
async function fetchSpacesWithRetry(username, token, maxRetries = 3, retryDelay = 2000) {
  let retries = 0;
  while (retries < maxRetries) {
    try {
      // 仅在 token 存在时添加 Authorization 头
      const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
      const response = await axios.get(`https://huggingface.co/api/spaces?author=${username}`, {
        headers,
        timeout: 10000 // 设置 10 秒超时
      });
      const spaces = response.data;
      logger.info(`获取到 ${spaces.length} 个 Spaces for ${username} (尝试 ${retries + 1}/${maxRetries})，使用 ${token ? 'Token 认证' : '无认证'}`);
      return spaces;
    } catch (error) {
      retries++;
      let errorDetail = error.message;
      if (error.response) {
        errorDetail += `, HTTP Status: ${error.response.status}`;
      } else if (error.request) {
        errorDetail += ', No response received (possible network issue)';
      }
      logger.error(`获取 Spaces 列表失败 for ${username} (尝试 ${retries}/${maxRetries}): ${errorDetail}，使用 ${token ? 'Token 认证' : '无认证'}`);
      if (retries < maxRetries) {
        logger.info(`等待 ${retryDelay/1000} 秒后重试...`);
        await new Promise(resolve => setTimeout(resolve, retryDelay));
      } else {
        logger.error(`达到最大重试次数 (${maxRetries})，放弃重试 for ${username}`);
        return [];
      }
    }
  }
  return [];
}

// 提供静态文件（前端文件）
app.use(express.static(path.join(__dirname, 'public')));

// 提供配置信息的 API 接口
app.get('/api/config', (req, res) => {
  res.json({ usernames: usernames.join(',') });
});

// 登录 API 接口
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
    // 生成一个随机 token 作为会话标识
    const token = crypto.randomBytes(16).toString('hex');
    const expiresAt = Date.now() + SESSION_TIMEOUT;
    sessions.set(token, { username, expiresAt });
    logger.info(`用户 ${username} 登录成功，生成 token: ${token.slice(0, 8)}...`);
    res.json({ success: true, token });
  } else {
    logger.info(`用户 ${username} 登录失败，凭据无效`);
    res.status(401).json({ success: false, message: '用户名或密码错误' });
  }
});

// 验证登录状态 API 接口
app.post('/api/verify-token', (req, res) => {
  const { token } = req.body;
  const session = sessions.get(token);
  if (session && session.expiresAt > Date.now()) {
    res.json({ success: true, message: 'Token 有效' });
  } else {
    if (session) {
      sessions.delete(token); // 删除过期的 token
      logger.info(`Token ${token.slice(0, 8)}... 已过期，已删除`);
    }
    res.status(401).json({ success: false, message: 'Token 无效或已过期' });
  }
});

// 登出 API 接口
app.post('/api/logout', (req, res) => {
  const { token } = req.body;
  sessions.delete(token);
  logger.info(`Token ${token.slice(0, 8)}... 已手动登出`);
  res.json({ success: true, message: '登出成功' });
});

// 中间件：验证请求中的 token
const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: '未提供有效的认证令牌' });
  }
  const token = authHeader.split(' ')[1];
  const session = sessions.get(token);
  if (session && session.expiresAt > Date.now()) {
    req.session = session;
    next();
  } else {
    if (session) {
      sessions.delete(token); // 删除过期的 token
      logger.info(`Token ${token.slice(0, 8)}... 已过期，拒绝访问`);
    }
    return res.status(401).json({ error: '认证令牌无效或已过期' });
  }
};

// 获取所有 spaces 列表（包括私有）
app.get('/api/proxy/spaces', async (req, res) => {
  try {
    // 检查是否登录
    let isAuthenticated = false;
    const authHeader = req.headers['authorization'];
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const token = authHeader.split(' ')[1];
      const session = sessions.get(token);
      if (session && session.expiresAt > Date.now()) {
        isAuthenticated = true;
        logger.info(`用户已登录，Token: ${token.slice(0, 8)}...`);
      } else {
        if (session) {
          sessions.delete(token); // 删除过期的 token
          logger.info(`Token ${token.slice(0, 8)}... 已过期，拒绝访问`);
        }
        logger.info('用户认证失败，无有效 Token');
      }
    } else {
      logger.info('用户未提供认证令牌');
    }

    // 如果缓存为空或已过期，强制重新获取数据
    const cachedSpaces = spaceCache.getAll();
    if (cachedSpaces.length === 0 || spaceCache.isExpired()) {
      logger.debug(cachedSpaces.length === 0 ? '缓存为空，强制重新获取数据' : '缓存已过期，重新获取数据');
      const allSpaces = [];
      for (const username of usernames) {
        const token = userTokenMapping[username];
        if (!token) {
          logger.warn(`用户 ${username} 没有配置 API Token，将尝试无认证访问公开数据`);
        }

        try {
          const spaces = await fetchSpacesWithRetry(username, token);
          for (const space of spaces) {
            try {
              // 仅在 token 存在时添加 Authorization 头
              const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
              const spaceInfoResponse = await axios.get(`https://huggingface.co/api/spaces/${space.id}`, { headers });
              const spaceInfo = spaceInfoResponse.data;
              const spaceRuntime = spaceInfo.runtime || {};

              allSpaces.push({
                repo_id: spaceInfo.id,
                name: spaceInfo.cardData?.title || spaceInfo.id.split('/')[1],
                owner: spaceInfo.author,
                username: username,
                url: `https://${spaceInfo.author}-${spaceInfo.id.split('/')[1]}.hf.space`,
                status: spaceRuntime.stage || 'unknown',
                last_modified: spaceInfo.lastModified || 'unknown',
                created_at: spaceInfo.createdAt || 'unknown',
                sdk: spaceInfo.sdk || 'unknown',
                tags: spaceInfo.tags || [],
                private: spaceInfo.private || false,
                app_port: spaceInfo.cardData?.app_port || 'unknown'
              });
            } catch (error) {
              logger.error(`处理 Space ${space.id} 失败:`, error.message, `使用 ${token ? 'Token 认证' : '无认证'}`);
            }
          }
        } catch (error) {
          logger.error(`获取 Spaces 列表失败 for ${username}:`, error.message, `使用 ${token ? 'Token 认证' : '无认证'}`);
        }
      }

      allSpaces.sort((a, b) => a.name.localeCompare(b.name));
      spaceCache.updateAll(allSpaces);
      logger.info(`总共获取到 ${allSpaces.length} 个 Spaces`);

      const safeSpaces = allSpaces.map(space => {
        const { token, ...safeSpace } = space;
        return safeSpace;
      });

      if (isAuthenticated) {
        logger.info('用户已登录，返回所有实例（包括 private）');
        res.json(safeSpaces);
      } else if (SHOW_PRIVATE) {
        logger.info('用户未登录，但 SHOW_PRIVATE 为 true，返回所有实例');
        res.json(safeSpaces);
      } else {
        logger.info('用户未登录，SHOW_PRIVATE 为 false，过滤 private 实例');
        res.json(safeSpaces.filter(space => !space.private));
      }
    } else {
      logger.debug('从缓存获取 Spaces 数据');
      const safeSpaces = cachedSpaces.map(space => {
        const { token, ...safeSpace } = space;
        return safeSpace;
      });

      if (isAuthenticated) {
        logger.info('用户已登录，返回所有缓存实例（包括 private）');
        return res.json(safeSpaces);
      } else if (SHOW_PRIVATE) {
        logger.info('用户未登录，但 SHOW_PRIVATE 为 true，返回所有缓存实例');
        return res.json(safeSpaces);
      } else {
        logger.info('用户未登录，SHOW_PRIVATE 为 false，过滤 private 实例');
        return res.json(safeSpaces.filter(space => !space.private));
      }
    }
  } catch (error) {
    logger.error(`代理获取 spaces 列表失败:`, error.message);
    res.status(500).json({ error: '获取 spaces 列表失败', details: error.message });
  }
});

// 代理重启 Space（需要认证）
app.post('/api/proxy/restart/:repoId(*)', authenticateToken, async (req, res) => {
  try {
    const { repoId } = req.params;
    logger.info(`尝试重启 Space: ${repoId}`);
    const spaces = spaceCache.getAll();
    const space = spaces.find(s => s.repo_id === repoId);
    if (!space || !userTokenMapping[space.username]) {
      logger.error(`Space ${repoId} 未找到或无 Token 配置`);
      return res.status(404).json({ error: 'Space 未找到或无 Token 配置' });
    }

    const headers = { 'Authorization': `Bearer ${userTokenMapping[space.username]}`, 'Content-Type': 'application/json' };
    const response = await axios.post(`https://huggingface.co/api/spaces/${repoId}/restart`, {}, { headers });
    logger.info(`重启 Space ${repoId} 成功，状态码: ${response.status}`);
    res.json({ success: true, message: `Space ${repoId} 重启成功` });
  } catch (error) {
    logger.error(`重启 space 失败 (${req.params.repoId}):`, error.message);
    if (error.response) {
      logger.error(`状态码: ${error.response.status}, 响应数据:`, error.response.data);
      res.status(error.response.status || 500).json({ error: '重启 space 失败', details: error.response.data?.message || error.message });
    } else {
      res.status(500).json({ error: '重启 space 失败', details: error.message });
    }
  }
});

// 代理重建 Space（需要认证）
app.post('/api/proxy/rebuild/:repoId(*)', authenticateToken, async (req, res) => {
  try {
    const { repoId } = req.params;
    logger.info(`尝试重建 Space: ${repoId}`);
    const spaces = spaceCache.getAll();
    const space = spaces.find(s => s.repo_id === repoId);
    if (!space || !userTokenMapping[space.username]) {
      logger.error(`Space ${repoId} 未找到或无 Token 配置`);
      return res.status(404).json({ error: 'Space 未找到或无 Token 配置' });
    }

    const headers = { 'Authorization': `Bearer ${userTokenMapping[space.username]}`, 'Content-Type': 'application/json' };
    // 将 factory_reboot 参数作为查询参数传递，而非请求体
    const response = await axios.post(
      `https://huggingface.co/api/spaces/${repoId}/restart?factory=true`,
      {},
      { headers }
    );
    logger.info(`重建 Space ${repoId} 成功，状态码: ${response.status}`);
    res.json({ success: true, message: `Space ${repoId} 重建成功` });
  } catch (error) {
    logger.error(`重建 space 失败 (${req.params.repoId}):`, error.message);
    if (error.response) {
      logger.error(`状态码: ${error.response.status}, 响应数据:`, error.response.data);
      res.status(error.response.status || 500).json({ error: '重建 space 失败', details: error.response.data?.message || error.message });
    } else {
      res.status(500).json({ error: '重建 space 失败', details: error.message });
    }
  }
});

// 获取定时重启配置
app.get('/api/schedule/restart/:repoId(*)', authenticateToken, (req, res) => {
  const { repoId } = req.params;
  const config = scheduledRestarts.get(repoId);
  if (config) {
    res.json({
      enabled: config.enabled,
      intervalHours: config.intervalHours,
      lastRestart: config.lastRestart
    });
  } else {
    res.json({ enabled: false, intervalHours: 0, lastRestart: null });
  }
});

// 设置定时重启配置
app.post('/api/schedule/restart/:repoId(*)', authenticateToken, (req, res) => {
  const { repoId } = req.params;
  const { enabled, intervalHours } = req.body;

  if (enabled && (!intervalHours || intervalHours < 1)) {
    return res.status(400).json({ error: '间隔时间必须至少为 1 小时' });
  }

  setScheduledRestart(repoId, intervalHours || 24, enabled);
  res.json({ success: true, message: enabled ? `已设置定时重启: 每 ${intervalHours} 小时` : '已禁用定时重启' });
});

// 获取保活配置
app.get('/api/keepalive/:repoId(*)', authenticateToken, (req, res) => {
  const { repoId } = req.params;
  const config = keepAliveConfigs.get(repoId);
  if (config) {
    res.json({
      enabled: config.enabled,
      intervalMinutes: config.intervalMinutes,
      lastPing: config.lastPing
    });
  } else {
    res.json({ enabled: false, intervalMinutes: 0, lastPing: null });
  }
});

// 设置保活配置
app.post('/api/keepalive/:repoId(*)', authenticateToken, (req, res) => {
  const { repoId } = req.params;
  const { enabled, intervalMinutes } = req.body;

  if (enabled && (!intervalMinutes || intervalMinutes < 1)) {
    return res.status(400).json({ error: '间隔时间必须至少为 1 分钟' });
  }

  setKeepAlive(repoId, intervalMinutes || 30, enabled);
  res.json({ success: true, message: enabled ? `已设置保活: 每 ${intervalMinutes} 分钟` : '已禁用保活' });
});

// 获取全局保活配置
app.get('/api/keepalive-global', authenticateToken, (req, res) => {
  res.json({
    enabled: globalKeepAlive.enabled,
    intervalMinutes: globalKeepAlive.intervalMinutes
  });
});

// 设置全局保活配置
app.post('/api/keepalive-global', authenticateToken, (req, res) => {
  const { enabled, intervalMinutes } = req.body;

  if (enabled && (!intervalMinutes || intervalMinutes < 1)) {
    return res.status(400).json({ error: '间隔时间必须至少为 1 分钟' });
  }

  setGlobalKeepAlive(intervalMinutes || 30, enabled);
  res.json({ success: true, message: enabled ? `已启用全局保活: 每 ${intervalMinutes} 分钟` : '已禁用全局保活' });
});

// 获取所有定时任务状态
app.get('/api/schedule/status', authenticateToken, (req, res) => {
  const restarts = [];
  scheduledRestarts.forEach((config, repoId) => {
    restarts.push({
      repoId,
      enabled: config.enabled,
      intervalHours: config.intervalHours,
      lastRestart: config.lastRestart
    });
  });

  const keepAlives = [];
  keepAliveConfigs.forEach((config, repoId) => {
    keepAlives.push({
      repoId,
      enabled: config.enabled,
      intervalMinutes: config.intervalMinutes,
      lastPing: config.lastPing
    });
  });

  res.json({
    scheduledRestarts: restarts,
    keepAlives: keepAlives,
    globalKeepAlive: {
      enabled: globalKeepAlive.enabled,
      intervalMinutes: globalKeepAlive.intervalMinutes
    }
  });
});

// 外部 API 服务（类似于 Flask 的 /api/v1）
app.get('/api/v1/info/:token', async (req, res) => {
  try {
    const { token } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== process.env.API_KEY) {
      return res.status(401).json({ error: '无效的 API 密钥' });
    }

    const headers = { 'Authorization': `Bearer ${token}` };
    const userInfoResponse = await axios.get('https://huggingface.co/api/whoami-v2', { headers });
    const username = userInfoResponse.data.name;
    const spacesResponse = await axios.get(`https://huggingface.co/api/spaces?author=${username}`, { headers });
    const spaces = spacesResponse.data;
    const spaceList = [];

    for (const space of spaces) {
      try {
        const spaceInfoResponse = await axios.get(`https://huggingface.co/api/spaces/${space.id}`, { headers });
        spaceList.push(spaceInfoResponse.data.id);
      } catch (error) {
        logger.error(`获取 Space 信息失败 (${space.id}):`, error.message);
      }
    }

    res.json({ spaces: spaceList, total: spaceList.length });
  } catch (error) {
    logger.error(`获取 spaces 列表失败 (外部 API):`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/v1/info/:token/:spaceId(*)', async (req, res) => {
  try {
    const { token, spaceId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== process.env.API_KEY) {
      return res.status(401).json({ error: '无效的 API 密钥' });
    }

    const headers = { 'Authorization': `Bearer ${token}` };
    const spaceInfoResponse = await axios.get(`https://huggingface.co/api/spaces/${spaceId}`, { headers });
    const spaceInfo = spaceInfoResponse.data;
    const spaceRuntime = spaceInfo.runtime || {};

    res.json({
      id: spaceInfo.id,
      status: spaceRuntime.stage || 'unknown',
      last_modified: spaceInfo.lastModified || null,
      created_at: spaceInfo.createdAt || null,
      sdk: spaceInfo.sdk || 'unknown',
      tags: spaceInfo.tags || [],
      private: spaceInfo.private || false
    });
  } catch (error) {
    logger.error(`获取 space 信息失败 (外部 API):`, error.message);
    res.status(error.response?.status || 404).json({ error: error.message });
  }
});

app.post('/api/v1/action/:token/:spaceId(*)/restart', async (req, res) => {
  try {
    const { token, spaceId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== process.env.API_KEY) {
      return res.status(401).json({ error: '无效的 API 密钥' });
    }

    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    await axios.post(`https://huggingface.co/api/spaces/${spaceId}/restart`, {}, { headers });
    res.json({ success: true, message: `Space ${spaceId} 重启成功` });
  } catch (error) {
    logger.error(`重启 space 失败 (外部 API):`, error.message);
    res.status(error.response?.status || 500).json({ success: false, error: error.message });
  }
});

app.post('/api/v1/action/:token/:spaceId(*)/rebuild', async (req, res) => {
  try {
    const { token, spaceId } = req.params;
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ') || authHeader.split(' ')[1] !== process.env.API_KEY) {
      return res.status(401).json({ error: '无效的 API 密钥' });
    }

    const headers = { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' };
    logger.info(`外部 API 发送重建请求，spaceId: ${spaceId}`);
    // 将 factory_reboot 参数作为查询参数传递，而非请求体
    const response = await axios.post(
      `https://huggingface.co/api/spaces/${spaceId}/restart?factory=true`,
      {},
      { headers }
    );
    logger.info(`外部 API 重建 Space ${spaceId} 成功，状态码: ${response.status}`);
    res.json({ success: true, message: `Space ${spaceId} 重建成功` });
  } catch (error) {
    logger.error(`重建 space 失败 (外部 API):`, error.message);
    if (error.response) {
      logger.error(`状态码: ${error.response.status}, 响应数据:`, error.response.data);
      res.status(error.response.status || 500).json({ success: false, error: error.response.data?.message || error.message });
    } else {
      res.status(500).json({ success: false, error: error.message });
    }
  }
});

// 监控数据管理类
class MetricsConnectionManager {
  constructor() {
    this.connections = new Map(); // 存储 HuggingFace API 的监控连接
    this.clients = new Map(); // 存储前端客户端的 SSE 连接
    this.instanceData = new Map(); // 存储每个实例的最新监控数据
  }

  // 建立到 HuggingFace API 的监控连接
  async connectToInstance(repoId, username, token) {
    if (this.connections.has(repoId)) {
      return this.connections.get(repoId);
    }

    const instanceId = repoId.split('/')[1];
    const url = `https://api.hf.space/v1/${username}/${instanceId}/live-metrics/sse`;
    // 仅在 token 存在且非空时添加 Authorization 头
    const headers = token ? {
      'Authorization': `Bearer ${token}`,
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    } : {
      'Accept': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive'
    };

    try {
      const response = await axios({
        method: 'get',
        url,
        headers,
        responseType: 'stream',
        timeout: 10000
      });

      const stream = response.data;
      stream.on('data', (chunk) => {
        const chunkStr = chunk.toString();
        if (chunkStr.includes('event: metric')) {
          const dataMatch = chunkStr.match(/data: (.*)/);
          if (dataMatch && dataMatch[1]) {
            try {
              const metrics = JSON.parse(dataMatch[1]);
              this.instanceData.set(repoId, metrics);
              // 推送给所有订阅了该实例的客户端
              this.clients.forEach((clientRes, clientId) => {
                if (clientRes.subscribedInstances && clientRes.subscribedInstances.includes(repoId)) {
                  clientRes.write(`event: metric\n`);
                  clientRes.write(`data: ${JSON.stringify({ repoId, metrics })}\n\n`);
                }
              });
            } catch (error) {
              logger.error(`解析监控数据失败 (${repoId}):`, error.message);
            }
          }
        }
      });

      stream.on('error', (error) => {
        logger.error(`监控连接错误 (${repoId}):`, error.message);
        this.connections.delete(repoId);
        this.instanceData.delete(repoId);
      });

      stream.on('end', () => {
        logger.info(`监控连接结束 (${repoId})`);
        this.connections.delete(repoId);
        this.instanceData.delete(repoId);
      });

      this.connections.set(repoId, stream);
      logger.info(`已建立监控连接 (${repoId})，使用 ${token ? 'Token 认证' : '无认证'}`);
      return stream;
    } catch (error) {
      logger.error(`无法连接到监控端点 (${repoId}):`, error.message);
      this.connections.delete(repoId);
      return null;
    }
  }

  // 注册前端客户端的 SSE 连接
  registerClient(clientId, res, subscribedInstances) {
    res.subscribedInstances = subscribedInstances || [];
    this.clients.set(clientId, res);
    logger.info(`客户端 ${clientId} 注册，订阅实例: ${res.subscribedInstances.join(', ') || '无'}`);
    
    // 首次连接时，推送已缓存的最新数据
    res.subscribedInstances.forEach(repoId => {
      if (this.instanceData.has(repoId)) {
        const metrics = this.instanceData.get(repoId);
        res.write(`event: metric\n`);
        res.write(`data: ${JSON.stringify({ repoId, metrics })}\n\n`);
      }
    });
  }

  // 客户端断开连接
  unregisterClient(clientId) {
    this.clients.delete(clientId);
    logger.info(`客户端 ${clientId} 断开连接`);
    this.cleanupConnections();
  }

  // 更新客户端订阅的实例列表
  updateClientSubscriptions(clientId, subscribedInstances) {
    const clientRes = this.clients.get(clientId);
    if (clientRes) {
      clientRes.subscribedInstances = subscribedInstances || [];
      logger.info(`客户端 ${clientId} 更新订阅: ${clientRes.subscribedInstances.join(', ') || '无'}`);
      // 更新后推送最新的缓存数据
      subscribedInstances.forEach(repoId => {
        if (this.instanceData.has(repoId)) {
          const metrics = this.instanceData.get(repoId);
          clientRes.write(`event: metric\n`);
          clientRes.write(`data: ${JSON.stringify({ repoId, metrics })}\n\n`);
        }
      });
    }
    this.cleanupConnections();
  }

  // 清理未被任何客户端订阅的连接
  cleanupConnections() {
    const subscribedRepoIds = new Set();
    this.clients.forEach(clientRes => {
      clientRes.subscribedInstances.forEach(repoId => subscribedRepoIds.add(repoId));
    });

    const toRemove = [];
    this.connections.forEach((stream, repoId) => {
      if (!subscribedRepoIds.has(repoId)) {
        toRemove.push(repoId);
        stream.destroy();
        logger.info(`清理未订阅的监控连接 (${repoId})`);
      }
    });

    toRemove.forEach(repoId => {
      this.connections.delete(repoId);
      this.instanceData.delete(repoId);
    });
  }
}

const metricsManager = new MetricsConnectionManager();

// 新增统一监控数据的SSE端点
app.get('/api/proxy/live-metrics-stream', (req, res) => {
  // 设置 SSE 所需的响应头
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  // 生成唯一的客户端ID
  const clientId = crypto.randomBytes(8).toString('hex');
  
  // 获取查询参数中的实例列表和 token
  const instancesParam = req.query.instances || '';
  const token = req.query.token || '';
  const subscribedInstances = instancesParam.split(',').filter(id => id.trim() !== '');

  // 检查登录状态
  let isAuthenticated = false;
  if (token) {
    const session = sessions.get(token);
    if (session && session.expiresAt > Date.now()) {
      isAuthenticated = true;
      logger.info(`SSE 用户已登录，Token: ${token.slice(0, 8)}...`);
    } else {
      if (session) {
        sessions.delete(token);
        logger.info(`SSE Token ${token.slice(0, 8)}... 已过期，拒绝访问`);
      }
      logger.info('SSE 用户认证失败，无有效 Token');
    }
  } else {
    logger.info('SSE 用户未提供认证令牌');
  }

  // 注册客户端
  metricsManager.registerClient(clientId, res, subscribedInstances);

  // 根据订阅列表建立监控连接
  const spaces = spaceCache.getAll();
  subscribedInstances.forEach(repoId => {
    const space = spaces.find(s => s.repo_id === repoId);
    if (space) {
      const username = space.username;
      const token = userTokenMapping[username] || '';
      metricsManager.connectToInstance(repoId, username, token);
    }
  });

  // 监听客户端断开连接
  req.on('close', () => {
    metricsManager.unregisterClient(clientId);
    logger.info(`客户端 ${clientId} 断开 SSE 连接`);
  });
});

// 新增接口：更新客户端订阅的实例列表
app.post('/api/proxy/update-subscriptions', (req, res) => {
  const { clientId, instances } = req.body;
  if (!clientId || !instances || !Array.isArray(instances)) {
    return res.status(400).json({ error: '缺少 clientId 或 instances 参数' });
  }

  metricsManager.updateClientSubscriptions(clientId, instances);
  // 根据新订阅列表建立监控连接
  const spaces = spaceCache.getAll();
  instances.forEach(repoId => {
    const space = spaces.find(s => s.repo_id === repoId);
    if (space) {
      const username = space.username;
      const token = userTokenMapping[username] || '';
      metricsManager.connectToInstance(repoId, username, token);
    }
  });

  res.json({ success: true, message: '订阅列表已更新' });
});

// ==================== 健康检查端点 ====================
const startTime = Date.now();

app.get('/health', (req, res) => {
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const memoryUsage = process.memoryUsage();
  
  res.json({
    status: 'healthy',
    uptime: uptime,
    uptimeFormatted: `${Math.floor(uptime / 86400)}d ${Math.floor((uptime % 86400) / 3600)}h ${Math.floor((uptime % 3600) / 60)}m`,
    memory: {
      heapUsed: Math.round(memoryUsage.heapUsed / 1024 / 1024) + 'MB',
      heapTotal: Math.round(memoryUsage.heapTotal / 1024 / 1024) + 'MB',
      rss: Math.round(memoryUsage.rss / 1024 / 1024) + 'MB'
    },
    cache: {
      spacesCount: spaceCache.getAll().length,
      isExpired: spaceCache.isExpired()
    },
    scheduledTasks: {
      restarts: scheduledRestarts.size,
      keepAlives: keepAliveConfigs.size,
      globalKeepAlive: globalKeepAlive.enabled
    },
    timestamp: new Date().toISOString()
  });
});

// ==================== OpenClaw Hugging Face Logs ====================
// 必须放在 app.get('*') 前面，否则 /api/openclaw/... 会被前端兜底页面吞掉。
app.use(openclawLogs({
  requireLogin: typeof authenticateToken === 'function'
    ? authenticateToken
    : undefined,

  sessions: typeof sessions !== 'undefined'
    ? sessions
    : undefined,

  userTokenMapping: typeof userTokenMapping !== 'undefined'
    ? userTokenMapping
    : undefined
}));

// 处理其他请求，重定向到 index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ==================== 全局错误处理 ====================
app.use((err, req, res, next) => {
  logger.error(`未处理的错误: ${err.message}`, err.stack);
  res.status(500).json({ 
    error: '服务器内部错误',
    message: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

process.on('uncaughtException', (err) => {
  logger.error('未捕获的异常:', err.message, err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('未处理的 Promise 拒绝:', reason);
});

// 定期清理过期的会话
setInterval(() => {
  const now = Date.now();
  for (const [token, session] of sessions.entries()) {
    if (session.expiresAt < now) {
      sessions.delete(token);
      logger.info(`Token ${token.slice(0, 8)}... 已过期，自动清理`);
    }
  }
}, 60 * 60 * 1000); // 每小时清理一次

// 定时刷新缓存任务
const REFRESH_INTERVAL = 5 * 60 * 1000; // 每 5 分钟检查一次
async function refreshSpacesCachePeriodically() {
  logger.info('启动定时刷新缓存任务...');
  setInterval(async () => {
    try {
      const cachedSpaces = spaceCache.getAll();
      if (spaceCache.isExpired() || cachedSpaces.length === 0) {
        logger.debug('定时任务：缓存已过期或为空，重新获取 Spaces 数据');
        const allSpaces = [];
        for (const username of usernames) {
          const token = userTokenMapping[username];
          if (!token) {
            logger.warn(`用户 ${username} 没有配置 API Token，将尝试无认证访问公开数据`);
          }
          try {
            const spaces = await fetchSpacesWithRetry(username, token);
            for (const space of spaces) {
              try {
                const headers = token ? { 'Authorization': `Bearer ${token}` } : {};
                const spaceInfoResponse = await axios.get(`https://huggingface.co/api/spaces/${space.id}`, { headers });
                const spaceInfo = spaceInfoResponse.data;
                const spaceRuntime = spaceInfo.runtime || {};

                allSpaces.push({
                  repo_id: spaceInfo.id,
                  name: spaceInfo.cardData?.title || spaceInfo.id.split('/')[1],
                  owner: spaceInfo.author,
                  username: username,
                  url: `https://${spaceInfo.author}-${spaceInfo.id.split('/')[1]}.hf.space`,
                  status: spaceRuntime.stage || 'unknown',
                  last_modified: spaceInfo.lastModified || 'unknown',
                  created_at: spaceInfo.createdAt || 'unknown',
                  sdk: spaceInfo.sdk || 'unknown',
                  tags: spaceInfo.tags || [],
                  private: spaceInfo.private || false,
                  app_port: spaceInfo.cardData?.app_port || 'unknown'
                });
              } catch (error) {
                logger.error(`处理 Space ${space.id} 失败:`, error.message);
              }
            }
          } catch (error) {
            logger.error(`获取 Spaces 列表失败 for ${username}:`, error.message);
          }
        }
        allSpaces.sort((a, b) => a.name.localeCompare(b.name));
        spaceCache.updateAll(allSpaces);
        logger.info(`定时任务：总共获取到 ${allSpaces.length} 个 Spaces，缓存已更新`);
      } else {
        logger.debug('定时任务：缓存有效且不为空，无需更新');
      }
    } catch (error) {
      logger.error('定时任务：刷新缓存失败:', error.message);
    }
  }, REFRESH_INTERVAL);
}

// ==================== 恢复持久化配置 ====================
function restorePersistedConfig() {
  const config = loadPersistedConfig();
  
  // 恢复定时重启配置
  if (config.scheduledRestarts) {
    for (const [repoId, cfg] of Object.entries(config.scheduledRestarts)) {
      if (cfg.enabled) {
        const intervalMs = cfg.intervalHours * 60 * 60 * 1000;
        const timerId = setInterval(() => executeScheduledRestart(repoId), intervalMs);
        scheduledRestarts.set(repoId, {
          enabled: true,
          intervalHours: cfg.intervalHours,
          lastRestart: null,
          timerId
        });
        logger.info(`恢复定时重启配置: ${repoId}, 间隔 ${cfg.intervalHours} 小时`);
      }
    }
  }
  
  // 恢复保活配置（需要等缓存加载后执行 ping）
  if (config.keepAliveConfigs) {
    for (const [repoId, cfg] of Object.entries(config.keepAliveConfigs)) {
      if (cfg.enabled) {
        const intervalMs = cfg.intervalMinutes * 60 * 1000;
        const timerId = setInterval(() => executeKeepAlivePing(repoId), intervalMs);
        keepAliveConfigs.set(repoId, {
          enabled: true,
          intervalMinutes: cfg.intervalMinutes,
          lastPing: null,
          timerId
        });
        logger.info(`恢复保活配置: ${repoId}, 间隔 ${cfg.intervalMinutes} 分钟`);
      }
    }
  }
  
  // 恢复全局保活配置
  if (config.globalKeepAlive && config.globalKeepAlive.enabled) {
    globalKeepAlive.enabled = true;
    globalKeepAlive.intervalMinutes = config.globalKeepAlive.intervalMinutes;
    const intervalMs = config.globalKeepAlive.intervalMinutes * 60 * 1000;
    globalKeepAlive.timerId = setInterval(executeGlobalKeepAlive, intervalMs);
    logger.info(`恢复全局保活配置, 间隔 ${config.globalKeepAlive.intervalMinutes} 分钟`);
  }
}

app.listen(port, () => {
  logger.info(`Server running on port ${port}`);
  logger.info(`User configurations:`, usernames.map(user => `${user}: ${userTokenMapping[user] ? 'Token Configured' : 'No Token'}`).join(', ') || 'None');
  logger.info(`Admin login enabled: Username=${ADMIN_USERNAME}, Password=${ADMIN_PASSWORD ? 'Configured' : 'Not Configured'}`);
  restorePersistedConfig(); // 恢复持久化配置
  refreshSpacesCachePeriodically(); // 启动定时任务
});
