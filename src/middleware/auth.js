import { ObjectId } from "mongodb";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import { getDatabase } from "../config/database.js";

const authenticationErrorCodes = new Set([
  "ERR_JOSE_ALG_NOT_ALLOWED",
  "ERR_JOSE_NOT_SUPPORTED",
  "ERR_JWS_INVALID",
  "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
  "ERR_JWT_CLAIM_VALIDATION_FAILED",
  "ERR_JWT_EXPIRED",
  "ERR_JWT_INVALID",
  "ERR_JWKS_NO_MATCHING_KEY",
]);

let remoteJwks;
let remoteJwksUrl;

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function getJwtConfiguration() {
  const jwksUrl = process.env.BETTER_AUTH_JWKS_URL;
  const issuer = process.env.JWT_ISSUER;
  const audience = process.env.JWT_AUDIENCE;

  if (!jwksUrl || !issuer || !audience) {
    throw createHttpError(
      500,
      "BETTER_AUTH_JWKS_URL, JWT_ISSUER, and JWT_AUDIENCE must be configured",
    );
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(jwksUrl);
  } catch {
    throw createHttpError(500, "BETTER_AUTH_JWKS_URL must be a valid URL");
  }

  if (parsedUrl.protocol !== "https:" && parsedUrl.protocol !== "http:") {
    throw createHttpError(500, "BETTER_AUTH_JWKS_URL must use HTTP or HTTPS");
  }

  if (!remoteJwks || remoteJwksUrl !== jwksUrl) {
    remoteJwks = createRemoteJWKSet(parsedUrl);
    remoteJwksUrl = jwksUrl;
  }

  return { keySet: remoteJwks, issuer, audience };
}

export function verifyJwt(req, res, next) {
  const authorization = req.get("authorization");
  const bearerMatch = authorization?.match(/^Bearer\s+(\S+)$/i);

  if (!bearerMatch) {
    return next(createHttpError(401, "A valid Bearer token is required"));
  }

  let configuration;
  try {
    configuration = getJwtConfiguration();
  } catch (error) {
    return next(error);
  }

  jwtVerify(bearerMatch[1], configuration.keySet, {
    issuer: configuration.issuer,
    audience: configuration.audience,
  })
    .then(({ payload }) => {
      if (typeof payload.sub !== "string" || payload.sub.length === 0) {
        return next(createHttpError(401, "Token subject is missing"));
      }

      req.auth = payload;
      return next();
    })
    .catch((error) => {
      if (
        error instanceof joseErrors.JOSEError &&
        authenticationErrorCodes.has(error.code)
      ) {
        return next(createHttpError(401, "Invalid or expired token"));
      }

      return next(error);
    });
}

export function loadUser(req, res, next) {
  const userId = req.auth?.sub;
  if (typeof userId !== "string" || userId.length === 0) {
    return next(createHttpError(401, "Authentication is required"));
  }

  const userIds = [{ _id: userId }];
  if (ObjectId.isValid(userId)) {
    userIds.push({ _id: new ObjectId(userId) });
  }

  getDatabase()
    .collection("users")
    .findOne({ $or: userIds })
    .then((user) => {
      if (!user) {
        return next(createHttpError(401, "User account was not found"));
      }

      if (user.isBlocked) {
        return next(createHttpError(403, "Account is blocked"));
      }

      req.user = user;
      return next();
    })
    .catch(next);
}
