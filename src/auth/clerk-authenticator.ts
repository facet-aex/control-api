import { verifyToken } from "@clerk/backend";

import { AppError } from "../errors.js";
import type {
  AuthenticatedIdentity,
  AuthenticationInput,
  IdentityAuthenticator,
} from "./types.js";

export interface ClerkAuthenticatorOptions {
  authorizedParties: string[];
  issuer?: string;
  jwtKey?: string;
  secretKey?: string;
}

export class ClerkAuthenticator implements IdentityAuthenticator {
  constructor(private readonly options: ClerkAuthenticatorOptions) {}

  async authenticate(
    input: AuthenticationInput,
  ): Promise<AuthenticatedIdentity> {
    const match = /^Bearer\s+(.+)$/iu.exec(input.authorization ?? "");
    if (!match?.[1]) {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "A Clerk session Bearer token is required.",
        401,
      );
    }

    try {
      const payload = await verifyToken(match[1], {
        authorizedParties: this.options.authorizedParties,
        ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
        ...(this.options.jwtKey ? { jwtKey: this.options.jwtKey } : {}),
        ...(this.options.secretKey
          ? { secretKey: this.options.secretKey }
          : {}),
      });

      if (!payload.sub) {
        throw new Error("verified Clerk token has no subject");
      }
      return { subject: payload.sub };
    } catch {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "The Clerk session token is invalid.",
        401,
      );
    }
  }
}
