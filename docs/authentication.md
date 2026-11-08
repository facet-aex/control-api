# Authentication boundary

FACET treats external authentication and domain authorization as separate concerns.

## Local demo mode

`FACET_AUTH_MODE=local` is accepted only with `FACET_ENV=local`. Protected routes require:

```http
x-facet-dev-user: demo-owner
```

Optional local-only profile hints are `x-facet-dev-email` and `x-facet-dev-display-name`. These headers are untrusted demo identities and must never be enabled in preview or production.

## Clerk mode

Set `FACET_AUTH_MODE=clerk` and provide either `CLERK_JWT_KEY` for networkless verification or `CLERK_SECRET_KEY` for JWKS lookup. The Control API accepts the Clerk session token as a Bearer token and verifies:

- token signature and time claims;
- the authorized party against `WEB_ORIGIN`;
- `CLERK_JWT_ISSUER` when configured.

The Clerk subject is mapped to a FACET `users` row. Provider membership in PostgreSQL remains authoritative for authorization; Clerk identity alone never grants access to a Provider.

## Role matrix

| Permission | Owner | Admin | Developer | Viewer |
|---|---:|---:|---:|---:|
| Read private provider data | yes | yes | yes | yes |
| Update provider profile | yes | yes | no | no |
| Create/edit Facet drafts | yes | yes | yes | no |
| Manage memberships | yes | yes | no | no |

Membership mutation endpoints and the final-owner invariant are implemented in the next Slice 1 increment. Cross-provider access is denied before repository mutation.
