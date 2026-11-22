import { ObjectId } from "mongodb";
import { createRemoteJWKSet, errors as joseErrors, jwtVerify } from "jose";
import { connectDatabase } from "../config/database.js";

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

export function getJwtConfiguration(environment = process.env) {
  let jwksUrl = environment.BETTER_AUTH_JWKS_URL;

  if (!jwksUrl && environment.BETTER_AUTH_URL) {
    try {
      jwksUrl =
        new URL(environment.BETTER_AUTH_URL).origin + "/api/auth/jwks";
    } catch {
      throw createHttpError(500, "BETTER_AUTH_URL must be a valid URL");
    }
  }

  if (!jwksUrl) {
    throw createHttpError(
      500,
      "BETTER_AUTH_JWKS_URL or BETTER_AUTH_URL must be configured",
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

  const origin = parsedUrl.origin;
  const configuredIssuer = environment.JWT_ISSUER;
  const configuredAudience = environment.JWT_AUDIENCE;

  let issuer = origin;
  let audience = origin;
  try {
    if (configuredIssuer) issuer = new URL(configuredIssuer).origin;
  } catch {}
  try {
    if (configuredAudience) audience = new URL(configuredAudience).origin;
  } catch {}

  if (issuer !== origin) issuer = origin;
  if (audience !== origin) audience = origin;

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

  connectDatabase()
    .then((database) => database.collection("users").findOne({ $or: userIds }))
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
