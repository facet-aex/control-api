import { createClerkClient, verifyToken } from "@clerk/backend";

import { AppError } from "../errors.js";
import { isValidUsername } from "../identifiers.js";
import type {
  AuthenticatedIdentity,
  AuthenticationInput,
  IdentityAuthenticator,
} from "./types.js";

export interface SyncedUserLookup {
  clerkId: string;
  username: string;
  status: "active" | "disabled";
}

export interface ClerkAuthenticatorOptions {
  authorizedParties: string[];
  issuer?: string;
  jwtKey?: string;
  secretKey?: string;
  findUserByClerkId?: (
    clerkId: string,
  ) => Promise<SyncedUserLookup | undefined>;
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

    if (this.options.findUserByClerkId) {
      const synced = await this.options.findUserByClerkId(subject);
      if (synced) {
        if (synced.status === "disabled") {
          throw new AppError(
            "AUTHORIZATION_DENIED",
            "This FACET user is disabled.",
            403,
          );
        }
        if (!isValidUsername(synced.username)) {
          throw new AppError(
            "USERNAME_REQUIRED",
            "Set an 8-16 character lowercase kebab-case username in Clerk.",
            409,
          );
        }
        return { subject, username: synced.username };
      }
    }

    if (!this.clerkClient) {
      throw new AppError(
        "USERNAME_REQUIRED",
        "Set an 8-16 character lowercase kebab-case username in Clerk.",
        409,
      );
    }

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

    if (!user.username || !isValidUsername(user.username)) {
      throw new AppError(
        "USERNAME_REQUIRED",
        "Set an 8-16 character lowercase kebab-case username in Clerk.",
        409,
      );
    }

    return { subject, username: user.username };
  }
}
