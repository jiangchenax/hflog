// Add near the top of server.js:
const openclawLogs = require('./server.openclaw-logs');

// Add after app is created and before app.listen(...):
app.use(openclawLogs({
  requireLogin: typeof requireLogin === 'function' ? requireLogin : undefined,
  sessionTokens: typeof sessionTokens !== 'undefined' ? sessionTokens : undefined
}));
