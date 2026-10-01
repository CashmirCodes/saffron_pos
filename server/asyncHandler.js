// Wraps an async Express handler so rejected promises are forwarded to
// Express's error handling instead of hanging the request.
module.exports = function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
};
