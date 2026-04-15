/**
 * Central error handler — formats all errors as consistent JSON responses.
 */
function errorHandler(err, req, res, next) {
  const status = err.status || 500;
  const message = err.message || 'Internal server error';

  console.error(`[${new Date().toISOString()}] ERROR ${status}: ${message}`);
  if (err.stack && process.env.NODE_ENV !== 'production') {
    console.error(err.stack);
  }

  res.status(status).json({
    error: true,
    status,
    message,
    ...(process.env.NODE_ENV !== 'production' && err.detail ? { detail: err.detail } : {})
  });
}

module.exports = errorHandler;