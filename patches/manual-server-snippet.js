// 放到 server.js 里 const app = express(); 后面：
const openclawLogs = require('./server.openclaw-logs');

// 必须放到 app.get('*', ...) catch-all 前面：
app.use(openclawLogs({
  requireLogin: typeof authenticateToken === 'function'
    ? authenticateToken
    : (typeof requireLogin === 'function' ? requireLogin : undefined),
  sessions: typeof sessions !== 'undefined' ? sessions : undefined,
  sessionTokens: typeof sessionTokens !== 'undefined' ? sessionTokens : undefined,
  userTokenMapping: typeof userTokenMapping !== 'undefined' ? userTokenMapping : undefined
}));
