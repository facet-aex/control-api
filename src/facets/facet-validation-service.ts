import type { AuthenticatedIdentity } from "../auth/types.js";
import { AppError } from "../errors.js";
import type { ProviderStore } from "../providers/provider-types.js";
import type {
  FacetValidationStore,
  StoredWarningAcknowledgement,
} from "./facet-validation-types.js";
import { validateFacetContext, warningId } from "./facet-validator.js";

function toPublic(
  saved: NonNullable<
    Awaited<ReturnType<FacetValidationStore["saveValidation"]>>
  >,
) {
  return {
    facetVersion: {
      version: saved.version,
      status: saved.status.toUpperCase() as "DRAFT" | "VALID",
      revision: saved.revision,
      validation: {
        status: saved.validation.status.toUpperCase() as "INVALID" | "VALID",
        errors: saved.validation.errors,
        warnings: saved.validation.warnings,
      },
      warningAcknowledgements: saved.warningAcknowledgements,
    },
  };
}

export class FacetValidationService {
  constructor(
    private readonly providers: ProviderStore,
    private readonly validations: FacetValidationStore,
  ) {}

  async validate(
    identity: AuthenticatedIdentity,
    input: {
      provider: string;
      facetName: string;
      version: string;
      revision: number;
      warningAcknowledgements: Array<{
        warningId: string;
        reason?: string | undefined;
      }>;
    },
    requestId: string,
  ) {
    const actor = await this.providers.upsertUser(identity);
    if (actor.username !== input.provider) {
      throw new AppError(
        "AUTHORIZATION_DENIED",
        "The authenticated user is not authorized for this provider.",
        403,
      );
    }
    const context = await this.validations.getContextByName(
      input.provider,
      input.facetName,
      input.version,
    );
    if (!context || context.providerId !== actor.id) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }
    if (context.status === "published" || context.status === "disabled") {
      throw new AppError(
        "RESOURCE_CONFLICT",
        "Published or disabled Facet Versions cannot be revalidated.",
        409,
      );
    }

    const validWarningIds = new Set(context.warnings.map(warningId));
    for (const acknowledgement of input.warningAcknowledgements) {
      if (!validWarningIds.has(acknowledgement.warningId)) {
        throw new AppError(
          "INPUT_INVALID",
          "A warning acknowledgement does not match a current warning.",
          400,
        );
      }
    }
    const supplied = new Map(
      input.warningAcknowledgements.map((item) => [item.warningId, item]),
    );
    const existing = new Map(
      context.warningAcknowledgements
        .filter((item) => validWarningIds.has(item.warningId))
        .map((item) => [item.warningId, item]),
    );
    const acknowledgedIds = new Set([...existing.keys(), ...supplied.keys()]);
    const validation = validateFacetContext(context, acknowledgedIds);
    const isValid =
      validation.errors.length === 0 &&
      validation.warnings.every((warning) => warning.acknowledged);
    const now = new Date().toISOString();
    const acknowledgements: StoredWarningAcknowledgement[] = [
      ...validWarningIds,
    ]
      .filter((id) => acknowledgedIds.has(id))
      .map((id) => {
        const current = supplied.get(id);
        const previous = existing.get(id);
        return current
          ? {
              warningId: id,
              ...(current.reason ? { reason: current.reason } : {}),
              acknowledgedAt: now,
              acknowledgedBy: actor.username,
            }
          : previous!;
      });

    const saved = await this.validations.saveValidation({
      actorUserId: actor.id,
      providerId: actor.id,
      facetVersionId: context.facetVersionId,
      expectedRevision: input.revision,
      status: isValid ? "valid" : "draft",
      validation: {
        status: isValid ? "valid" : "invalid",
        errors: validation.errors,
        warnings: validation.warnings,
      },
      warningAcknowledgements: acknowledgements,
      requestId,
    });
    if (!saved) {
      throw new AppError("RESOURCE_NOT_FOUND", "Facet version not found.", 404);
    }
    return toPublic(saved);
  }
}
