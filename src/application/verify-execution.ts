import type {
  ExecutionEvidenceEntry,
  ExecutionFailureCode,
  ExecutionRun,
  ScenarioExecution,
  StepExecution,
} from '../domain/execution.js';
import type { Viewport } from '../domain/inspection.js';
import { compareStrings } from '../domain/determinism.js';
import type {
  DefectFinding,
  DefectSignature,
  FindingsArtifact,
  VerificationAttempt,
  VerificationCandidate,
  VerificationLimits,
  VerificationRun,
  VerificationSummary,
} from '../domain/verification.js';
import { VerificationMarkdownRenderer } from '../reporting/verification-markdown.js';
import type { Clock, RunIdGenerator } from './ports.js';
import { sha256Digest } from './source-integrity.js';
import {
  VerificationCandidateExtractor,
  verificationTriggerForEvidence,
} from './verification-candidates.js';
import type {
  LoadedVerificationSource,
  VerificationArtifactReader,
  VerificationArtifactWriter,
  VerificationScenarioRunner,
} from './verification-ports.js';
import { VerificationSourceValidator } from './verification-source-validator.js';
import { DefectSignatureService } from './verification-signature.js';
import { DefectFindingFactory, ReproducibilityClassifier } from './verification-verdict.js';
import {
  FindingsIntegrityService,
  VerificationIntegrityService,
  type UnsignedFindingsArtifact,
  type UnsignedVerificationRun,
} from './verification-integrity.js';

export interface VerifyExecutionOptions extends VerificationLimits {
  readonly headless: boolean;
  readonly viewport: Viewport;
  readonly navigationTimeoutMs: number;
  readonly maxStepsPerScenario: number;
  readonly executionTimeoutMs: number;
  readonly stepTimeoutMs: number;
}

export interface VerifyExecutionOutcome {
  readonly result: VerificationRun;
  readonly findings: FindingsArtifact;
  readonly artifactDirectory: string;
  readonly exitCode: 0 | 1 | 2;
}

function firstFailedStep(scenario: ScenarioExecution): StepExecution | undefined {
  return scenario.steps.find((step) => step.status === 'FAIL');
}

function relevantStep(
  scenario: ScenarioExecution,
  candidate: VerificationCandidate,
): StepExecution | undefined {
  if (candidate.sourceStepId !== null) {
    const matched = scenario.steps.find((step) => step.planStepId === candidate.sourceStepId);
    if (matched !== undefined) return matched;
  }
  return scenario.steps.at(-1);
}

function uniqueSignatures(values: readonly DefectSignature[]): readonly DefectSignature[] {
  return [...new Map(values.map((value) => [value.hash, value])).values()].sort((left, right) =>
    compareStrings(left.hash, right.hash),
  );
}

export function verificationSummaryFor(
  discovered: number,
  selected: readonly VerificationCandidate[],
  attempts: Readonly<Record<string, readonly VerificationAttempt[]>>,
  findings: readonly DefectFinding[],
  attemptsPerCandidate: number,
  limitReached: readonly string[],
): VerificationSummary {
  const allAttempts = selected.flatMap((candidate) => attempts[candidate.id] ?? []);
  return {
    candidatesDiscovered: discovered,
    candidatesSelected: selected.length,
    attemptsRequested:
      selected.filter((candidate) => candidate.rerun).length * attemptsPerCandidate,
    attemptsCompleted: allAttempts.length,
    validAttempts: allAttempts.filter((attempt) => ['PASS', 'FAIL'].includes(attempt.status))
      .length,
    confirmed: findings.filter((finding) => finding.verdict === 'CONFIRMED_DEFECT').length,
    probable: findings.filter((finding) => finding.verdict === 'PROBABLE_DEFECT').length,
    flaky: findings.filter((finding) => finding.verdict === 'FLAKY_DEFECT').length,
    notReproduced: findings.filter((finding) => finding.verdict === 'NOT_REPRODUCED').length,
    inconclusive: findings.filter((finding) => finding.verdict === 'INCONCLUSIVE').length,
    nonDefectSignals: findings.filter((finding) => finding.verdict === 'NON_DEFECT_SIGNAL').length,
    infrastructureErrors:
      allAttempts.filter((attempt) => attempt.status === 'ERROR').length +
      selected.filter((candidate) => candidate.triggerKind === 'EXECUTION_ERROR').length,
    limitReached,
  };
}

export function verificationExitCode(summary: VerificationSummary): 0 | 1 | 2 {
  if (summary.infrastructureErrors > 0 || summary.limitReached.includes('verification_timeout')) {
    return 2;
  }
  if (summary.confirmed + summary.probable + summary.flaky > 0) return 1;
  return 0;
}

export class VerifyExecution {
  private readonly validator = new VerificationSourceValidator();
  private readonly extractor = new VerificationCandidateExtractor();
  private readonly signatures = new DefectSignatureService();
  private readonly classifier = new ReproducibilityClassifier();
  private readonly findingsFactory = new DefectFindingFactory();
  private readonly markdown = new VerificationMarkdownRenderer();
  private readonly verificationIntegrity = new VerificationIntegrityService();
  private readonly findingsIntegrity = new FindingsIntegrityService();

  public constructor(
    private readonly reader: VerificationArtifactReader,
    private readonly writer: VerificationArtifactWriter,
    private readonly runner: VerificationScenarioRunner,
    private readonly runIds: RunIdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    executionPath: string,
    options: VerifyExecutionOptions,
  ): Promise<VerifyExecutionOutcome> {
    const loaded = await this.reader.loadVerificationSource(executionPath);
    this.validator.validate(loaded);
    const discovered = this.extractor.extract(
      loaded.execution,
      loaded.executionInput.exploration.startUrl,
    );
    const selected = discovered.slice(0, options.maxFindings);
    const startedAt = this.clock.now();
    const verificationId = `verify-${this.runIds.next(startedAt)}`;
    const locations = await this.writer.prepareVerification(loaded.runDirectory, verificationId);
    const deadline = Date.now() + options.verifyTimeoutMs;
    const attemptsByCandidate: Record<string, readonly VerificationAttempt[]> = {};
    const warnings: string[] = [];
    const browserVersions = new Set<string>();
    let globalTimeoutReached = false;

    if (discovered.length > selected.length) warnings.push('Verification candidate limit reached.');
    for (const candidate of selected) {
      const attempts: VerificationAttempt[] = [];
      if (candidate.rerun) {
        for (let attemptNumber = 1; attemptNumber <= options.attempts; attemptNumber += 1) {
          const remainingMs = deadline - Date.now();
          if (remainingMs < 250) {
            globalTimeoutReached = true;
            break;
          }
          attempts.push(
            await this.executeAttempt({
              loaded,
              candidate,
              attemptNumber,
              verificationDirectory: locations.directory,
              options,
              remainingMs,
              browserVersions,
            }),
          );
        }
      }
      attemptsByCandidate[candidate.id] = attempts;
      if (globalTimeoutReached) break;
    }
    if (globalTimeoutReached) {
      warnings.push('Global verification timeout reached before all requested attempts completed.');
      for (const candidate of selected) attemptsByCandidate[candidate.id] ??= [];
    }

    const verifiedAt = this.clock.now();
    const findings = selected.map((candidate) => {
      const attempts = attemptsByCandidate[candidate.id] ?? [];
      const result = this.classifier.classify(candidate, attempts, options.attempts);
      return this.findingsFactory.create({
        candidate,
        attempts,
        result,
        plan: loaded.executionInput.plan,
        source: loaded.executionInput.exploration,
        execution: loaded.execution,
        verifiedAt: verifiedAt.toISOString(),
        sourceScreenshotPrefix: loaded.sourceExecutionRelativePath,
      });
    });
    const limitReached = [
      ...(discovered.length > selected.length ? ['max_findings'] : []),
      ...(globalTimeoutReached ? ['verification_timeout'] : []),
    ];
    const summary = verificationSummaryFor(
      discovered.length,
      selected,
      attemptsByCandidate,
      findings,
      options.attempts,
      limitReached,
    );
    const completedAt = this.clock.now();
    const unsignedResult: UnsignedVerificationRun = {
      schemaVersion: '1.1',
      verificationId,
      sourceRunId: loaded.execution.sourceRunId,
      sourceExecutionId: loaded.execution.executionId,
      planId: loaded.execution.planId,
      startedAt: startedAt.toISOString(),
      completedAt: completedAt.toISOString(),
      durationMs: Math.max(0, completedAt.getTime() - startedAt.getTime()),
      attemptPolicy: {
        attemptsPerCandidate: options.attempts,
        minimumValidAttempts: 2,
        maxFindings: options.maxFindings,
        timeoutMs: options.verifyTimeoutMs,
      },
      environment: {
        nodeVersion: process.version,
        platform: process.platform,
        browserName: 'chromium',
        browserVersions: [...browserVersions].sort(),
        viewport: options.viewport,
        headless: options.headless,
      },
      sourceIntegrity: {
        algorithm: 'SHA-256',
        sourceExecutionDigest: sha256Digest(loaded.execution),
        planDigest: loaded.execution.sourceIntegrity.planDigest,
        explorationDigest: loaded.execution.sourceIntegrity.explorationDigest,
        observationDigest: loaded.execution.sourceIntegrity.observationDigest,
        graphDigest: loaded.execution.sourceIntegrity.graphDigest,
        stateGraphDigest: loaded.execution.sourceIntegrity.stateGraphDigest,
      },
      summary,
      candidates: selected,
      attempts: attemptsByCandidate,
      signatures: uniqueSignatures([
        ...selected.map((candidate) => candidate.signature),
        ...Object.values(attemptsByCandidate)
          .flat()
          .flatMap((attempt) => (attempt.signature === null ? [] : [attempt.signature])),
      ]),
      findings,
      warnings,
      artifacts: {
        report: 'verification.json',
        markdown: 'verification.md',
        findings: 'findings.json',
        attemptsDirectory: 'attempts',
      },
    };
    const result: VerificationRun = {
      ...unsignedResult,
      verificationIntegrity: this.verificationIntegrity.create(unsignedResult),
    };
    const unsignedFindings: UnsignedFindingsArtifact = {
      schemaVersion: '1.1',
      verificationId,
      sourceRunId: result.sourceRunId,
      sourceExecutionId: result.sourceExecutionId,
      attemptPolicy: result.attemptPolicy,
      summary,
      findings,
      sourceIntegrity: {
        ...result.sourceIntegrity,
        verificationDigest: this.verificationIntegrity.digest(result),
      },
    };
    const findingsArtifact: FindingsArtifact = {
      ...unsignedFindings,
      findingsIntegrity: this.findingsIntegrity.create(unsignedFindings),
    };
    await this.writer.saveVerification(
      locations.directory,
      result,
      findingsArtifact,
      this.markdown.render(result),
    );
    return {
      result,
      findings: findingsArtifact,
      artifactDirectory: locations.directory,
      exitCode: verificationExitCode(summary),
    };
  }

  private async executeAttempt(input: {
    readonly loaded: LoadedVerificationSource;
    readonly candidate: VerificationCandidate;
    readonly attemptNumber: number;
    readonly verificationDirectory: string;
    readonly options: VerifyExecutionOptions;
    readonly remainingMs: number;
    readonly browserVersions: Set<string>;
  }): Promise<VerificationAttempt> {
    const target = this.writer.attemptTarget(
      input.verificationDirectory,
      input.candidate.id,
      input.attemptNumber,
    );
    const started = Date.now();
    try {
      const outcome = await this.runner.runScenario({
        planPath: input.loaded.planFile,
        scenarioId: input.candidate.scenarioId,
        explorationPath: input.loaded.explorationFile,
        artifacts: target.writer,
        options: {
          headless: input.options.headless,
          viewport: input.options.viewport,
          navigationTimeoutMs: Math.min(input.options.navigationTimeoutMs, input.remainingMs),
          maxScenarios: 1,
          maxStepsPerScenario: input.options.maxStepsPerScenario,
          executionTimeoutMs: Math.min(input.options.executionTimeoutMs, input.remainingMs),
          stepTimeoutMs: Math.min(input.options.stepTimeoutMs, input.remainingMs),
        },
      });
      input.browserVersions.add(outcome.result.environment.browserVersion);
      const scenario = outcome.result.scenarios[0];
      if (scenario === undefined) {
        return this.errorAttempt(input, started, 'No scenario result.');
      }
      return this.attemptFromExecution(input, scenario, outcome.result, target.relativeDirectory);
    } catch (error) {
      return this.errorAttempt(
        input,
        started,
        error instanceof Error ? error.message : 'Unexpected verification attempt error.',
      );
    }
  }

  private attemptFromExecution(
    input: {
      readonly loaded: LoadedVerificationSource;
      readonly candidate: VerificationCandidate;
      readonly attemptNumber: number;
    },
    scenario: ScenarioExecution,
    execution: ExecutionRun,
    relativeDirectory: string,
  ): VerificationAttempt {
    const step = relevantStep(scenario, input.candidate);
    const signal = this.attemptSignal(input.loaded, input.candidate, scenario, execution.evidence);
    return {
      attemptNumber: input.attemptNumber,
      executionId: execution.executionId,
      scenarioId: input.candidate.scenarioId,
      status: scenario.status,
      failureCode: scenario.failureCode,
      actualUrl: step?.actualUrl ?? null,
      actualFingerprint: step?.actualFingerprint ?? null,
      expectedUrl: this.expectedUrl(input.loaded, step),
      expectedFingerprint: step?.expectedFingerprint ?? null,
      durationMs: execution.durationMs,
      signalReproduced: signal.reproduced,
      signature: signal.signature,
      evidenceRefs: signal.evidenceRefs.map(
        (reference) => `${relativeDirectory}/execution.json#${reference}`,
      ),
      screenshotRefs: scenario.screenshotRefs.map(
        (reference) => `${relativeDirectory}/${reference}`,
      ),
      executionArtifact: `${relativeDirectory}/execution.json`,
      traceArtifact: `${relativeDirectory}/trace.zip`,
      error: null,
    };
  }

  private attemptSignal(
    loaded: LoadedVerificationSource,
    candidate: VerificationCandidate,
    scenario: ScenarioExecution,
    evidence: readonly ExecutionEvidenceEntry[],
  ): {
    readonly reproduced: boolean | null;
    readonly signature: DefectSignature | null;
    readonly evidenceRefs: readonly string[];
  } {
    if (['BLOCKED', 'ERROR', 'SKIPPED'].includes(scenario.status)) {
      return { reproduced: null, signature: null, evidenceRefs: [] };
    }
    if (candidate.triggerKind === 'STRUCTURAL_MISMATCH') {
      if (scenario.status !== 'FAIL') {
        return { reproduced: false, signature: null, evidenceRefs: [] };
      }
      const step = firstFailedStep(scenario);
      if (step === undefined) return { reproduced: null, signature: null, evidenceRefs: [] };
      const signature = this.signatures.structural(scenario, step);
      return {
        reproduced: signature.hash === candidate.signature.hash,
        signature,
        evidenceRefs: step.evidenceRefs,
      };
    }
    const evidenceTrigger = candidate.triggerKind;
    if (evidenceTrigger === 'SOURCE_BLOCKED' || evidenceTrigger === 'EXECUTION_ERROR') {
      return { reproduced: null, signature: null, evidenceRefs: [] };
    }
    const sourceOrigin = new URL(loaded.executionInput.exploration.startUrl).origin;
    const steps = new Map(scenario.steps.map((step) => [step.id, step.planStepId]));
    const matchingKind = evidence
      .filter(
        (entry) =>
          entry.scenarioId === scenario.id &&
          verificationTriggerForEvidence(entry, sourceOrigin) === evidenceTrigger &&
          (candidate.sourceStepId === null ||
            steps.get(entry.stepId ?? '') === candidate.sourceStepId),
      )
      .map((entry) => ({
        entry,
        signature: this.signatures.evidence(
          candidate.scenarioId,
          candidate.sourceStepId,
          entry,
          evidenceTrigger,
        ),
      }));
    const exact = matchingKind.find((entry) => entry.signature.hash === candidate.signature.hash);
    const observed = exact ?? matchingKind[0];
    return {
      reproduced: exact !== undefined,
      signature: observed?.signature ?? null,
      evidenceRefs: matchingKind.map((entry) => entry.entry.id),
    };
  }

  private expectedUrl(
    loaded: LoadedVerificationSource,
    step: StepExecution | undefined,
  ): string | null {
    const pageId = step?.transition.plannedTargetPageId;
    if (pageId === null || pageId === undefined) return null;
    return (
      loaded.executionInput.exploration.graph.nodes.find((page) => page.id === pageId)?.finalUrl ??
      null
    );
  }

  private errorAttempt(
    input: { readonly candidate: VerificationCandidate; readonly attemptNumber: number },
    started: number,
    message: string,
  ): VerificationAttempt {
    return {
      attemptNumber: input.attemptNumber,
      executionId: null,
      scenarioId: input.candidate.scenarioId,
      status: 'ERROR',
      failureCode: 'BROWSER_ERROR' satisfies ExecutionFailureCode,
      actualUrl: null,
      actualFingerprint: null,
      expectedUrl: null,
      expectedFingerprint: null,
      durationMs: Math.max(0, Date.now() - started),
      signalReproduced: null,
      signature: null,
      evidenceRefs: [],
      screenshotRefs: [],
      executionArtifact: null,
      traceArtifact: null,
      error: message,
    };
  }
}
