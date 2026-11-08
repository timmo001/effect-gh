import { Effect, Schema } from "effect";
import { Gh, type GhOptions } from "./gh.js";

/** The repository or owner whose attestations to use; gh needs one of them. */
export type Subject =
  | { readonly owner: string; readonly repo?: undefined }
  | { readonly repo: string; readonly owner?: undefined };

const subjectArgs = (subject: Subject) =>
  subject.repo === undefined
    ? ["--owner", subject.owner]
    : ["--repo", subject.repo];

const optional = (flag: string, value: string | undefined) =>
  value === undefined ? [] : [flag, value];

/** Input for {@link download}. */
export type DownloadInput = Subject & {
  /** A local file path or an `oci://` image reference. */
  readonly artifact: string;
  readonly digestAlg?: "sha256" | "sha512";
  readonly predicateType?: string;
  readonly hostname?: string;
  readonly limit?: number;
};

/** Download an artifact's attestations as `sha256-<digest>.jsonl` into `options.cwd`. */
export const download = Effect.fn("Attestation.download")(function* (
  input: DownloadInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  yield* gh.execute(
    [
      "attestation",
      "download",
      ...subjectArgs(input),
      ...optional("--digest-alg", input.digestAlg),
      ...optional("--predicate-type", input.predicateType),
      ...optional("--hostname", input.hostname),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      "--",
      input.artifact,
    ],
    options,
  );
});

export const Verification = Schema.Struct({
  attestation: Schema.Unknown,
  verificationResult: Schema.Unknown,
});

export interface Verification extends Schema.Schema.Type<typeof Verification> {}

/** Input for {@link verify}. */
export type VerifyInput = Subject & {
  /** A local file path or an `oci://` image reference. */
  readonly artifact: string;
  /** Verify against a local attestation bundle instead of fetching one. */
  readonly bundle?: string;
  readonly bundleFromOci?: boolean;
  readonly certIdentity?: string;
  readonly certIdentityRegex?: string;
  readonly certOidcIssuer?: string;
  readonly customTrustedRoot?: string;
  readonly denySelfHostedRunners?: boolean;
  readonly noPublicGood?: boolean;
  readonly predicateType?: string;
  readonly signerDigest?: string;
  readonly signerRepo?: string;
  readonly signerWorkflow?: string;
  readonly sourceDigest?: string;
  readonly sourceRef?: string;
  readonly digestAlg?: "sha256" | "sha512";
  readonly hostname?: string;
  readonly limit?: number;
};

/** Verify an artifact's attestations. gh exits non-zero when verification fails. */
export const verify = Effect.fn("Attestation.verify")(function* (
  input: VerifyInput,
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return yield* gh.json(
    [
      "attestation",
      "verify",
      "--format",
      "json",
      ...subjectArgs(input),
      ...optional("--bundle", input.bundle),
      ...(input.bundleFromOci === true ? ["--bundle-from-oci"] : []),
      ...optional("--cert-identity", input.certIdentity),
      ...optional("--cert-identity-regex", input.certIdentityRegex),
      ...optional("--cert-oidc-issuer", input.certOidcIssuer),
      ...optional("--custom-trusted-root", input.customTrustedRoot),
      ...(input.denySelfHostedRunners === true
        ? ["--deny-self-hosted-runners"]
        : []),
      ...(input.noPublicGood === true ? ["--no-public-good"] : []),
      ...optional("--predicate-type", input.predicateType),
      ...optional("--signer-digest", input.signerDigest),
      ...optional("--signer-repo", input.signerRepo),
      ...optional("--signer-workflow", input.signerWorkflow),
      ...optional("--source-digest", input.sourceDigest),
      ...optional("--source-ref", input.sourceRef),
      ...optional("--digest-alg", input.digestAlg),
      ...optional("--hostname", input.hostname),
      ...(input.limit === undefined ? [] : ["--limit", String(input.limit)]),
      "--",
      input.artifact,
    ],
    Schema.Array(Verification),
    options,
  );
});

/** Input for {@link trustedRoot}. */
export interface TrustedRootInput {
  readonly hostname?: string;
  readonly tufRoot?: string;
  readonly tufUrl?: string;
}

/** The trusted root as JSON lines, as `gh attestation trusted-root` prints it. */
export const trustedRoot = Effect.fn("Attestation.trustedRoot")(function* (
  input: TrustedRootInput = {},
  options?: GhOptions,
) {
  const gh = yield* Gh;

  return (yield* gh.execute(
    [
      "attestation",
      "trusted-root",
      ...optional("--hostname", input.hostname),
      ...optional("--tuf-root", input.tufRoot),
      ...optional("--tuf-url", input.tufUrl),
    ],
    options,
  )).stdout;
});
