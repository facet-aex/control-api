import type { AppConfig } from "../config.js";
import { ClerkAuthenticator } from "./clerk-authenticator.js";
import { LocalAuthenticator } from "./local-authenticator.js";
import type { IdentityAuthenticator } from "./types.js";

export function createAuthenticator(config: AppConfig): IdentityAuthenticator {
  if (config.FACET_AUTH_MODE === "local") return new LocalAuthenticator();

  return new ClerkAuthenticator({
    authorizedParties: [config.WEB_ORIGIN],
    ...(config.CLERK_JWT_ISSUER ? { issuer: config.CLERK_JWT_ISSUER } : {}),
    ...(config.CLERK_JWT_KEY ? { jwtKey: config.CLERK_JWT_KEY } : {}),
    ...(config.CLERK_SECRET_KEY ? { secretKey: config.CLERK_SECRET_KEY } : {}),
  });
}
