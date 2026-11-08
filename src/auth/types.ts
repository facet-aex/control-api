export interface AuthenticatedIdentity {
  subject: string;
  email?: string;
  displayName?: string;
}

export interface AuthenticationInput {
  authorization?: string | undefined;
  devUser?: string | undefined;
  devEmail?: string | undefined;
  devDisplayName?: string | undefined;
}

export interface IdentityAuthenticator {
  authenticate(input: AuthenticationInput): Promise<AuthenticatedIdentity>;
}
