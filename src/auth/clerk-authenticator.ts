import { createClerkClient, verifyToken } from "@clerk/backend";

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
  private readonly clerkClient;

  constructor(private readonly options: ClerkAuthenticatorOptions) {
    this.clerkClient = options.secretKey
      ? createClerkClient({ secretKey: options.secretKey })
      : null;
  }

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

    let subject: string;
    try {
      const payload = await verifyToken(match[1], {
        authorizedParties: this.options.authorizedParties,
        ...(this.options.issuer ? { issuer: this.options.issuer } : {}),
        ...(this.options.jwtKey ? { jwtKey: this.options.jwtKey } : {}),
        ...(this.options.secretKey
          ? { secretKey: this.options.secretKey }
          : {}),
      });

      if (!payload.sub) throw new Error("verified Clerk token has no subject");
      subject = payload.sub;
    } catch {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "The Clerk session token is invalid.",
        401,
      );
    }
    if (!this.clerkClient) return { subject };
    let user;
    try {
      user = await this.clerkClient.users.getUser(subject);
    } catch {
      throw new AppError(
        "CLERK_PROFILE_UNAVAILABLE",
        "Clerk user profile could not be loaded.",
        503,
      );
    }
    if (!user.username || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(user.username)) {
      throw new AppError(
        "USERNAME_REQUIRED",
        "Set a lowercase username using letters, numbers and hyphens in Clerk.",
        409,
      );
    }
    const displayName =
      [user.firstName, user.lastName].filter(Boolean).join(" ") ||
      user.username;
    return { subject, username: user.username, displayName };
  }
}
