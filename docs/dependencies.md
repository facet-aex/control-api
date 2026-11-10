# Runtime dependency decisions

Dependencies are direct only when the service owns the behavior and cannot rely on a transitive package contract.

## Ajv 8.20.0

- **Need:** compile and validate untrusted normalized Facet input/output/error schemas as JSON Schema 2020-12 during Phase 1 draft validation. Fastify's transitive validator is not a stable application import and the older top-level transitive Ajv 6 does not implement draft 2020-12.
- **License:** MIT, verified from package metadata/lockfile.
- **Maintenance:** official `ajv-validator` packages; Ajv 8.20.0 is the current documented v8 line consulted on 2026-11-10. Pin exact versions and reassess advisories during dependency updates.
- **Boundary:** use the dedicated Ajv 2020 class in strict mode. The draft manifest validator registers only the UUID format it needs; normalized provider schemas are compiled structurally with format assertion disabled. No custom code-generating keywords or remote schema loading. Validation errors are mapped to safe path/keyword messages and never echo payloads or secrets.
