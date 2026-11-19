export interface FacetValidationIssue {
  code: string;
  message: string;
  path?: string | undefined;
}

export interface FacetValidationWarning extends FacetValidationIssue {
  warningId: string;
  acknowledged: boolean;
}

export interface StoredWarningAcknowledgement {
  warningId: string;
  reason?: string | undefined;
  acknowledgedAt: string;
  acknowledgedBy: string;
}

export interface FacetValidationContext {
  facetVersionId: string;
  providerId: string;
  provider: string;
  facetName: string;
  version: string;
  status: "draft" | "valid" | "published" | "disabled";
  revision: number;
  manifest: unknown;
  endpointConfig: {
    authKind: "none" | "api_key_header" | "api_key_query" | "bearer";
    secretRefId: string | null;
  } | null;
  warnings: Array<{ code: string; message: string }>;
  warningAcknowledgements: StoredWarningAcknowledgement[];
}

export interface StoredFacetValidation {
  facetVersionId: string;
  version: string;
  status: "draft" | "valid";
  revision: number;
  validation: {
    status: "invalid" | "valid";
    errors: FacetValidationIssue[];
    warnings: FacetValidationWarning[];
  };
  warningAcknowledgements: StoredWarningAcknowledgement[];
}

export interface FacetValidationStore {
  getContextByName(
    provider: string,
    facetName: string,
    version: string,
  ): Promise<FacetValidationContext | undefined>;
  saveValidation(input: {
    actorUserId: string;
    providerId: string;
    facetVersionId: string;
    expectedRevision: number;
    status: "draft" | "valid";
    validation: StoredFacetValidation["validation"];
    warningAcknowledgements: StoredWarningAcknowledgement[];
    requestId: string;
  }): Promise<StoredFacetValidation | undefined>;
}
