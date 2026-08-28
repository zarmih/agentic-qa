import type { ExecutionIntegrity, ExecutionRun } from '../domain/execution.js';
import { canonicalJson, sha256Digest } from './source-integrity.js';

export type UnsignedExecutionRun = Omit<ExecutionRun, 'executionIntegrity'>;

export function executionPayload(run: ExecutionRun): UnsignedExecutionRun {
  const { executionIntegrity, ...payload } = run;
  void executionIntegrity;
  return payload;
}

export class ExecutionIntegrityService {
  public create(payload: UnsignedExecutionRun): ExecutionIntegrity {
    return { algorithm: 'SHA-256', payloadDigest: sha256Digest(payload) };
  }

  public validate(run: ExecutionRun): boolean {
    return (
      canonicalJson(this.create(executionPayload(run))) === canonicalJson(run.executionIntegrity)
    );
  }
}
