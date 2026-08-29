import { createHash } from 'node:crypto';
import type {
  RegressionGenerationLimits,
  RegressionGenerationStatus,
  RegressionManifest,
  RegressionManifestEntry,
} from '../domain/regression.js';
import type { DefectFinding } from '../domain/verification.js';
import { RegressionReadmeRenderer } from '../reporting/regression-readme.js';
import {
  RegressionTypeScriptRenderer,
  regressionAssertionDescription,
} from '../reporting/regression-typescript.js';
import type { Clock, RunIdGenerator } from './ports.js';
import {
  RegressionCompiler,
  RegressionDuplicateDetector,
  RegressionEligibilityPolicy,
} from './regression-compiler.js';
import type {
  RegressionArtifactReader,
  RegressionArtifactWriter,
  RegressionSourceCodeValidator,
  RegressionSourceFormatter,
  RenderedRegressionTest,
} from './regression-ports.js';
import { RegressionSourceValidator } from './regression-source-validator.js';
import { FindingsIntegrityService } from './verification-integrity.js';
import { RegressionUrlPolicy } from './regression-url-policy.js';
import { sha256Digest } from './source-integrity.js';
import {
  RegressionManifestIntegrityService,
  type UnsignedRegressionManifest,
} from './regression-integrity.js';

const VERDICT_RANK = {
  CONFIRMED_DEFECT: 0,
  PROBABLE_DEFECT: 1,
  FLAKY_DEFECT: 2,
  NOT_REPRODUCED: 3,
  INCONCLUSIVE: 4,
  NON_DEFECT_SIGNAL: 5,
} as const;
const SEVERITY_RANK = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3, INFO: 4 } as const;

export interface GenerateRegressionsOptions extends RegressionGenerationLimits {
  readonly includeFlaky: boolean;
  readonly baseUrl?: string;
}

export interface GenerateRegressionsOutcome {
  readonly manifest: RegressionManifest;
  readonly artifactDirectory: string;
  readonly exitCode: 0 | 1;
}

export function regressionFileDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function ordered(findings: readonly DefectFinding[]): readonly DefectFinding[] {
  return findings
    .map((finding, index) => ({ finding, index }))
    .sort(
      (left, right) =>
        VERDICT_RANK[left.finding.verdict] - VERDICT_RANK[right.finding.verdict] ||
        SEVERITY_RANK[left.finding.severity] - SEVERITY_RANK[right.finding.severity] ||
        left.index - right.index ||
        left.finding.id.localeCompare(right.finding.id),
    )
    .map(({ finding }) => finding);
}

function entry(
  finding: DefectFinding,
  status: RegressionGenerationStatus,
  reason: string,
  values: {
    readonly file?: string | null;
    readonly assertions?: readonly string[];
    readonly sourceDigest?: string;
    readonly fileDigest?: string | null;
  } = {},
): RegressionManifestEntry {
  return {
    findingId: finding.id,
    scenarioId: finding.scenarioId,
    verdict: finding.verdict,
    severity: finding.severity,
    status,
    file: values.file ?? null,
    reason,
    assertions: values.assertions ?? [],
    sourceDigest: values.sourceDigest ?? sha256Digest(finding),
    fileDigest: values.fileDigest ?? null,
  };
}

export class GenerateRegressions {
  private readonly sourceValidator = new RegressionSourceValidator();
  private readonly eligibility = new RegressionEligibilityPolicy();
  private readonly compiler = new RegressionCompiler();
  private readonly renderer = new RegressionTypeScriptRenderer();
  private readonly readme = new RegressionReadmeRenderer();
  private readonly findingsIntegrity = new FindingsIntegrityService();
  private readonly manifestIntegrity = new RegressionManifestIntegrityService();

  public constructor(
    private readonly reader: RegressionArtifactReader,
    private readonly writer: RegressionArtifactWriter,
    private readonly formatter: RegressionSourceFormatter,
    private readonly codeValidator: RegressionSourceCodeValidator,
    private readonly runIds: RunIdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    findingsPath: string,
    options: GenerateRegressionsOptions,
  ): Promise<GenerateRegressionsOutcome> {
    const loaded = await this.reader.loadRegressionSource(findingsPath);
    this.sourceValidator.validate(loaded);
    const checkedUrl = new RegressionUrlPolicy(
      loaded.verificationSource.executionInput.exploration.startUrl,
      options.baseUrl,
    );
    const generatedAt = this.clock.now();
    const generationId = `generate-${this.runIds.next(generatedAt)}`;
    const entries: RegressionManifestEntry[] = [];
    const rendered: RenderedRegressionTest[] = [];
    const duplicates = new RegressionDuplicateDetector();
    let generatedCount = 0;
    const targetOrigin = checkedUrl.targetOrigin;

    for (const finding of ordered(loaded.findings.findings)) {
      const eligibility = this.eligibility.classify(finding, options.includeFlaky);
      if (eligibility.kind === 'REVIEW_ONLY') {
        entries.push(entry(finding, 'REVIEW_ONLY', eligibility.reason));
        continue;
      }
      if (eligibility.kind === 'SKIPPED_VERDICT') {
        entries.push(entry(finding, 'SKIPPED_VERDICT', eligibility.reason));
        continue;
      }
      if (generatedCount >= options.maxGeneratedTests) {
        entries.push(
          entry(
            finding,
            'SKIPPED_LIMIT',
            'The deterministic maximum generated test count was reached.',
          ),
        );
        continue;
      }
      const compilation = this.compiler.compile({
        finding,
        mode: eligibility.mode,
        verification: loaded.verification,
        plan: loaded.verificationSource.executionInput.plan,
        source: loaded.verificationSource.executionInput.exploration,
        sourceExecution: loaded.verificationSource.execution,
        ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
        limits: options,
      });
      if (compilation.spec === null || compilation.candidate === null) {
        entries.push(entry(finding, 'UNSUPPORTED', compilation.reason));
        continue;
      }
      const duplicateOf = duplicates.register(compilation.spec, finding.id);
      if (duplicateOf !== null) {
        entries.push(
          entry(
            finding,
            'SKIPPED_DUPLICATE',
            `The compiled action path and assertions duplicate ${duplicateOf}.`,
          ),
        );
        continue;
      }
      const fileName = `${finding.id}.spec.ts`;
      const source = await this.formatter.format(this.renderer.render(compilation.spec));
      this.codeValidator.validate(fileName, source);
      const digest = regressionFileDigest(source);
      const output: RenderedRegressionTest = {
        spec: compilation.spec,
        fileName,
        source,
        digest,
        lines: source.split('\n').length - 1,
      };
      rendered.push(output);
      generatedCount += 1;
      entries.push(
        entry(
          finding,
          eligibility.mode === 'FIXME' ? 'GENERATED_FIXME' : 'GENERATED',
          compilation.reason,
          {
            file: `tests/${fileName}`,
            assertions: compilation.spec.assertions.map(regressionAssertionDescription),
            sourceDigest: sha256Digest({ finding, candidate: compilation.candidate }),
            fileDigest: digest,
          },
        ),
      );
    }
    const count = (status: RegressionGenerationStatus) =>
      entries.filter((item) => item.status === status).length;
    const unsignedManifest: UnsignedRegressionManifest = {
      schemaVersion: '1.1',
      generationId,
      sourceRunId: loaded.findings.sourceRunId,
      verificationId: loaded.findings.verificationId,
      generatedAt: generatedAt.toISOString(),
      options: {
        includeFlaky: options.includeFlaky,
        maxGeneratedTests: options.maxGeneratedTests,
        maxStepsPerTest: options.maxStepsPerTest,
        maxAssertionsPerTest: options.maxAssertionsPerTest,
        targetOrigin,
      },
      summary: {
        findings: entries.length,
        eligible: entries.filter((item) =>
          [
            'GENERATED',
            'GENERATED_FIXME',
            'UNSUPPORTED',
            'SKIPPED_LIMIT',
            'SKIPPED_DUPLICATE',
          ].includes(item.status),
        ).length,
        generated: count('GENERATED'),
        generatedFixme: count('GENERATED_FIXME'),
        reviewOnly: count('REVIEW_ONLY'),
        unsupported: count('UNSUPPORTED'),
        skippedVerdict: count('SKIPPED_VERDICT'),
        skippedLimit: count('SKIPPED_LIMIT'),
        duplicates: count('SKIPPED_DUPLICATE'),
        totalGeneratedLines: rendered.reduce((total, item) => total + item.lines, 0),
      },
      tests: entries,
      sourceIntegrity: {
        algorithm: 'SHA-256',
        findingsDigest: this.findingsIntegrity.digest(loaded.findings),
        verificationDigest: loaded.findings.sourceIntegrity.verificationDigest,
        sourceExecutionDigest: loaded.findings.sourceIntegrity.sourceExecutionDigest,
        planDigest: loaded.findings.sourceIntegrity.planDigest,
        explorationDigest: loaded.findings.sourceIntegrity.explorationDigest,
        graphDigest: loaded.findings.sourceIntegrity.graphDigest,
        stateGraphDigest: loaded.findings.sourceIntegrity.stateGraphDigest,
      },
    };
    const manifest: RegressionManifest = {
      ...unsignedManifest,
      generationIntegrity: this.manifestIntegrity.create(unsignedManifest),
    };
    const locations = await this.writer.prepareGeneration(loaded.runDirectory, generationId);
    await this.writer.saveGeneration(locations, manifest, this.readme.render(manifest), rendered);
    const exitCode = manifest.summary.reviewOnly + manifest.summary.unsupported > 0 ? 1 : 0;
    return { manifest, artifactDirectory: locations.directory, exitCode };
  }
}
