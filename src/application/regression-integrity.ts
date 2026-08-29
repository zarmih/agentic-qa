import type {
  RegressionManifest,
  RegressionManifestIntegrity,
  RegressionManifestPayload,
} from '../domain/regression.js';
import { canonicalJson, sha256Digest } from './source-integrity.js';

export type UnsignedRegressionManifest = RegressionManifestPayload & {
  readonly schemaVersion: '1.1';
};

export function regressionManifestPayload(
  manifest: RegressionManifest,
): UnsignedRegressionManifest {
  const { generationIntegrity, ...payload } = manifest;
  void generationIntegrity;
  return payload;
}

export class RegressionManifestIntegrityService {
  public create(payload: UnsignedRegressionManifest): RegressionManifestIntegrity {
    return { algorithm: 'SHA-256', payloadDigest: sha256Digest(payload) };
  }

  public validate(manifest: RegressionManifest): boolean {
    return (
      canonicalJson(this.create(regressionManifestPayload(manifest))) ===
      canonicalJson(manifest.generationIntegrity)
    );
  }
}
