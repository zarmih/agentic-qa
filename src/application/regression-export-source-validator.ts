import { createHash } from 'node:crypto';
import type { RegressionManifestEntry } from '../domain/regression.js';
import {
  RegressionTypeScriptRenderer,
  regressionAssertionDescription,
} from '../reporting/regression-typescript.js';
import { ExportSourceError } from './errors.js';
import type { LoadedRegressionExportSource } from './export-ports.js';
import { RegressionCompiler, RegressionEligibilityPolicy } from './regression-compiler.js';
import { RegressionManifestIntegrityService } from './regression-integrity.js';
import type { RegressionSourceFormatter } from './regression-ports.js';
import { RegressionSourceValidator } from './regression-source-validator.js';
import { canonicalJson, sha256Digest } from './source-integrity.js';

const GENERATED = new Set(['GENERATED', 'GENERATED_FIXME']);
const ELIGIBLE = new Set([
  'GENERATED',
  'GENERATED_FIXME',
  'UNSUPPORTED',
  'SKIPPED_LIMIT',
  'SKIPPED_DUPLICATE',
]);

function count(
  entries: readonly RegressionManifestEntry[],
  status: RegressionManifestEntry['status'],
): number {
  return entries.filter((entry) => entry.status === status).length;
}

function duplicates(values: readonly string[]): boolean {
  return new Set(values).size !== values.length;
}

function sourceFileDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export interface ValidatedRegressionExportSource {
  readonly loaded: LoadedRegressionExportSource;
  readonly warnings: readonly string[];
  readonly manifestDigest: string;
  readonly generationPayloadDigest: string | null;
}

export class RegressionExportSourceValidator {
  private readonly upstream = new RegressionSourceValidator();
  private readonly manifestIntegrity = new RegressionManifestIntegrityService();
  private readonly eligibility = new RegressionEligibilityPolicy();
  private readonly compiler = new RegressionCompiler();
  private readonly renderer = new RegressionTypeScriptRenderer();

  public constructor(private readonly formatter: RegressionSourceFormatter) {}

  public async validate(
    loaded: LoadedRegressionExportSource,
  ): Promise<ValidatedRegressionExportSource> {
    this.upstream.validate(loaded.regressionSource);
    const { manifest } = loaded;
    const source = loaded.regressionSource.verificationSource.executionInput.exploration;
    const plan = loaded.regressionSource.verificationSource.executionInput.plan;
    const execution = loaded.regressionSource.verificationSource.execution;
    const verification = loaded.regressionSource.verification;
    const findingsArtifact = loaded.regressionSource.findings;
    if (manifest.schemaVersion === '1.1' && !this.manifestIntegrity.validate(manifest)) {
      throw new ExportSourceError('Regression manifest payload digest does not match.');
    }
    if (
      manifest.sourceRunId !== source.runId ||
      manifest.verificationId !== verification.verificationId ||
      manifest.generationId !== loaded.manifest.generationId
    ) {
      throw new ExportSourceError('Manifest IDs do not match the validated source chain.');
    }
    const expectedIntegrity = {
      algorithm: 'SHA-256' as const,
      findingsDigest: sha256Digest(findingsArtifact),
      verificationDigest: findingsArtifact.sourceIntegrity.verificationDigest,
      sourceExecutionDigest: findingsArtifact.sourceIntegrity.sourceExecutionDigest,
      planDigest: findingsArtifact.sourceIntegrity.planDigest,
      explorationDigest: findingsArtifact.sourceIntegrity.explorationDigest,
      graphDigest: findingsArtifact.sourceIntegrity.graphDigest,
      stateGraphDigest: findingsArtifact.sourceIntegrity.stateGraphDigest,
    };
    if (canonicalJson(manifest.sourceIntegrity) !== canonicalJson(expectedIntegrity)) {
      throw new ExportSourceError('Manifest source-chain digests do not match verified artifacts.');
    }
    try {
      const target = new URL(manifest.options.targetOrigin);
      if (
        !['http:', 'https:'].includes(target.protocol) ||
        target.origin !== manifest.options.targetOrigin
      ) {
        throw new Error('not an origin');
      }
    } catch {
      throw new ExportSourceError('Manifest targetOrigin is not a safe HTTP(S) origin.');
    }
    if (
      manifest.tests.length !== findingsArtifact.findings.length ||
      duplicates(manifest.tests.map((entry) => entry.findingId)) ||
      duplicates(manifest.tests.flatMap((entry) => (entry.file === null ? [] : [entry.file])))
    ) {
      throw new ExportSourceError('Manifest entries do not map one-to-one to verified findings.');
    }

    let totalGeneratedLines = 0;
    for (const entry of manifest.tests) {
      const finding = findingsArtifact.findings.find((item) => item.id === entry.findingId);
      if (finding === undefined) {
        throw new ExportSourceError(`Manifest finding metadata is invalid for ${entry.findingId}.`);
      }
      if (
        entry.scenarioId !== finding.scenarioId ||
        entry.verdict !== finding.verdict ||
        entry.severity !== finding.severity
      ) {
        throw new ExportSourceError(`Manifest finding metadata is invalid for ${entry.findingId}.`);
      }
      const policy = this.eligibility.classify(finding, manifest.options.includeFlaky);
      if (GENERATED.has(entry.status)) {
        if (entry.file === null || entry.fileDigest === null || policy.kind !== 'COMPILE') {
          throw new ExportSourceError(
            `Manifest executable eligibility is invalid for ${entry.findingId}.`,
          );
        }
        const expectedStatus = policy.mode === 'FIXME' ? 'GENERATED_FIXME' : 'GENERATED';
        if (entry.status !== expectedStatus || entry.file !== `tests/${finding.id}.spec.ts`) {
          throw new ExportSourceError(
            `Manifest generated status or filename is invalid for ${entry.findingId}.`,
          );
        }
        const compilation = this.compiler.compile({
          finding,
          mode: policy.mode,
          verification,
          plan,
          source,
          sourceExecution: execution,
          baseUrl: manifest.options.targetOrigin,
          limits: manifest.options,
        });
        if (compilation.spec === null || compilation.candidate === null) {
          throw new ExportSourceError(`Generated entry no longer compiles for ${entry.findingId}.`);
        }
        const expectedSource = await this.formatter.format(this.renderer.render(compilation.spec));
        const actualSource = loaded.generatedFiles.get(entry.file);
        if (
          actualSource !== expectedSource ||
          sourceFileDigest(actualSource) !== entry.fileDigest ||
          entry.sourceDigest !== sha256Digest({ finding, candidate: compilation.candidate }) ||
          canonicalJson(entry.assertions) !==
            canonicalJson(compilation.spec.assertions.map(regressionAssertionDescription))
        ) {
          throw new ExportSourceError(`DIGEST_MISMATCH or renderer mismatch for ${entry.file}.`);
        }
        totalGeneratedLines += actualSource.split('\n').length - 1;
      } else {
        if (entry.file !== null || entry.fileDigest !== null) {
          throw new ExportSourceError(`Non-generated entry unexpectedly contains a file.`);
        }
        if (policy.kind === 'REVIEW_ONLY' && entry.status !== 'REVIEW_ONLY') {
          throw new ExportSourceError(`Review-only verdict was changed for ${entry.findingId}.`);
        }
        if (policy.kind === 'SKIPPED_VERDICT' && entry.status !== 'SKIPPED_VERDICT') {
          throw new ExportSourceError(`Skipped verdict was changed for ${entry.findingId}.`);
        }
        if (
          policy.kind === 'COMPILE' &&
          !['UNSUPPORTED', 'SKIPPED_LIMIT', 'SKIPPED_DUPLICATE'].includes(entry.status)
        ) {
          throw new ExportSourceError(`Eligible finding status is invalid for ${entry.findingId}.`);
        }
      }
    }
    const expectedSummary = {
      findings: manifest.tests.length,
      eligible: manifest.tests.filter((entry) => ELIGIBLE.has(entry.status)).length,
      generated: count(manifest.tests, 'GENERATED'),
      generatedFixme: count(manifest.tests, 'GENERATED_FIXME'),
      reviewOnly: count(manifest.tests, 'REVIEW_ONLY'),
      unsupported: count(manifest.tests, 'UNSUPPORTED'),
      skippedVerdict: count(manifest.tests, 'SKIPPED_VERDICT'),
      skippedLimit: count(manifest.tests, 'SKIPPED_LIMIT'),
      duplicates: count(manifest.tests, 'SKIPPED_DUPLICATE'),
      totalGeneratedLines,
    };
    if (canonicalJson(expectedSummary) !== canonicalJson(manifest.summary)) {
      throw new ExportSourceError('Regression manifest summary is inconsistent.');
    }
    return {
      loaded,
      warnings:
        manifest.schemaVersion === '1.0'
          ? [
              'Legacy regression manifest 1.0 has no payload digest; it was accepted only after full deterministic source and byte revalidation.',
            ]
          : [],
      manifestDigest: sha256Digest(manifest),
      generationPayloadDigest:
        manifest.schemaVersion === '1.1' ? manifest.generationIntegrity.payloadDigest : null,
    };
  }
}
