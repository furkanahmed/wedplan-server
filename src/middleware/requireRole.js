function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) {
      return next(createHttpError(401, "Authentication is required"));
    }

    if (!roles.includes(req.user.role)) {
      return next(createHttpError(403, "You do not have permission to access this resource"));
    }

    return next();
  };
}
