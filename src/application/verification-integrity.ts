import type {
  FindingsArtifact,
  VerificationIntegrity,
  VerificationRun,
} from '../domain/verification.js';
import { canonicalJson, sha256Digest } from './source-integrity.js';

export type UnsignedVerificationRun = Omit<VerificationRun, 'verificationIntegrity'>;
export type UnsignedFindingsArtifact = Omit<FindingsArtifact, 'findingsIntegrity'>;

export function verificationPayload(run: VerificationRun): UnsignedVerificationRun {
  const { verificationIntegrity, ...payload } = run;
  void verificationIntegrity;
  return payload;
}

export function findingsPayload(artifact: FindingsArtifact): UnsignedFindingsArtifact {
  const { findingsIntegrity, ...payload } = artifact;
  void findingsIntegrity;
  return payload;
}

export class VerificationIntegrityService {
  public create(payload: UnsignedVerificationRun): VerificationIntegrity {
    return { algorithm: 'SHA-256', payloadDigest: sha256Digest(payload) };
  }

  public validate(run: VerificationRun): boolean {
    return (
      canonicalJson(this.create(verificationPayload(run))) ===
      canonicalJson(run.verificationIntegrity)
    );
  }

  public digest(run: VerificationRun): string {
    return sha256Digest(run);
  }
}

export class FindingsIntegrityService {
  public create(payload: UnsignedFindingsArtifact): VerificationIntegrity {
    return { algorithm: 'SHA-256', payloadDigest: sha256Digest(payload) };
  }

  public validate(artifact: FindingsArtifact): boolean {
    return (
      canonicalJson(this.create(findingsPayload(artifact))) ===
      canonicalJson(artifact.findingsIntegrity)
    );
  }

  public digest(artifact: FindingsArtifact): string {
    return sha256Digest(artifact);
  }
}
