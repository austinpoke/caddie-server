/**
 * Simple request logger middleware.
 * Logs method, path, status, and response time.
 */
function requestLogger(req, res, next) {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ts = new Date().toISOString();
    console.log(`[${ts}] ${req.method} ${req.path} → ${res.statusCode} (${ms}ms)`);
  });
  next();
}

module.exports = requestLogger;