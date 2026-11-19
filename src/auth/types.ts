export interface AuthenticatedIdentity {
  subject: string;
  username?: string;
}

export interface AuthenticationInput {
  authorization?: string | undefined;
  devUser?: string | undefined;
}

export interface IdentityAuthenticator {
  authenticate(input: AuthenticationInput): Promise<AuthenticatedIdentity>;
}
