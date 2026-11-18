import { AppError } from "../errors.js";
import type {
  AuthenticatedIdentity,
  AuthenticationInput,
  IdentityAuthenticator,
} from "./types.js";

const SUBJECT_PATTERN = /^[a-zA-Z0-9._:@/-]{1,128}$/u;

export class LocalAuthenticator implements IdentityAuthenticator {
  async authenticate(
    input: AuthenticationInput,
  ): Promise<AuthenticatedIdentity> {
    const subject = input.devUser?.trim();
    if (!subject) {
      throw new AppError(
        "AUTHENTICATION_REQUIRED",
        "Set x-facet-dev-user when using local authentication.",
        401,
      );
    }
    if (!SUBJECT_PATTERN.test(subject)) {
      throw new AppError(
        "INPUT_INVALID",
        "The local user subject is invalid.",
        400,
      );
    }

    return {
      subject: `local:${subject}`,
      ...(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(subject)
        ? { username: subject }
        : {}),
      ...(input.devEmail ? { email: input.devEmail.trim().toLowerCase() } : {}),
      ...(input.devDisplayName
        ? { displayName: input.devDisplayName.trim() }
        : {}),
    };
  }
}
