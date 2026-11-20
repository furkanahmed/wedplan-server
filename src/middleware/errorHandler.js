export function notFoundHandler(req, res, next) {
  const error = new Error("Route not found");
  error.statusCode = 404;
  next(error);
}

export function errorHandler(error, req, res, next) {
  if (res.headersSent) {
    return next(error);
  }

  const statusCode =
    Number.isInteger(error.statusCode) && error.statusCode >= 400 && error.statusCode <= 599
      ? error.statusCode
      : 500;

  if (statusCode >= 500) {
    console.error(error);
  }

  return res.status(statusCode).json({
    success: false,
    message: statusCode >= 500 ? "Internal server error" : error.message,
  });
}
