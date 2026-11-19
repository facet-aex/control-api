export const FACET_TYPES = ["API", "ACTOR", "AGENT"] as const;
export type FacetType = (typeof FACET_TYPES)[number];

export const PRICING_MODELS = ["PAY_PER_RUN", "PAY_PER_RESULT"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

export const USER_STATUSES = ["active", "disabled"] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const USERNAME_MIN = 8 as const;
export const USERNAME_MAX = 16 as const;
export const USERNAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$" as const;
export const USERNAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const FACET_NAME_MIN = 4 as const;
export const FACET_NAME_MAX = 32 as const;
export const FACET_NAME_PATTERN = "^[a-z0-9]+(?:-[a-z0-9]+)*$" as const;
export const FACET_NAME_REGEX = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

export const SEMVER_PATTERN =
  "^(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)\\.(?:0|[1-9][0-9]*)$" as const;
export const SEMVER_REGEX =
  /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;

export function isValidUsername(value: string): boolean {
  return (
    value.length >= USERNAME_MIN &&
    value.length <= USERNAME_MAX &&
    USERNAME_REGEX.test(value)
  );
}

export function isValidFacetName(value: string): boolean {
  return (
    value.length >= FACET_NAME_MIN &&
    value.length <= FACET_NAME_MAX &&
    FACET_NAME_REGEX.test(value)
  );
}

export function isValidSemver(value: string): boolean {
  return SEMVER_REGEX.test(value);
}

export interface SemVerParts {
  major: number;
  minor: number;
  patch: number;
}

export function parseSemver(value: string): SemVerParts | null {
  if (!isValidSemver(value)) return null;
  const [majorStr, minorStr, patchStr] = value.split(".");
  return {
    major: Number(majorStr),
    minor: Number(minorStr),
    patch: Number(patchStr),
  };
}

export function compareSemver(a: string, b: string): number {
  const pa = parseSemver(a);
  const pb = parseSemver(b);
  if (!pa || !pb) {
    throw new Error(`Invalid SemVer comparison: '${a}' vs '${b}'`);
  }
  if (pa.major !== pb.major) return pa.major - pb.major;
  if (pa.minor !== pb.minor) return pa.minor - pb.minor;
  return pa.patch - pb.patch;
}

export function bumpPatchSemver(value: string): string {
  const parts = parseSemver(value);
  if (!parts) {
    throw new Error(`Invalid SemVer '${value}'`);
  }
  return `${parts.major}.${parts.minor}.${parts.patch + 1}`;
}

export function suggestFacetName(displayName: string): string {
  let normalized = displayName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[đĐ]/gu, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");

  if (normalized.length > FACET_NAME_MAX) {
    normalized = normalized.slice(0, FACET_NAME_MAX).replace(/-+$/gu, "");
  }
  if (normalized.length < FACET_NAME_MIN) {
    normalized = normalized ? `${normalized}-facet` : "new-facet";
    normalized = normalized.slice(0, FACET_NAME_MAX).replace(/-+$/gu, "");
  }
  if (!isValidFacetName(normalized)) {
    return "new-facet";
  }
  return normalized;
}
