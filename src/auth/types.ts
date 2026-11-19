export interface AuthenticatedIdentity {
  subject: string;
  username?: string;
  walletAddress?: string | undefined;
}

export interface AuthenticationInput {
  authorization?: string | undefined;
  devUser?: string | undefined;
}

export interface IdentityAuthenticator {
  authenticate(input: AuthenticationInput): Promise<AuthenticatedIdentity>;
}
