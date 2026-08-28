import { createHash } from 'node:crypto';
import type { PlanningTokenUsage, QaPlan } from '../domain/planning.js';
import { QaPlanMarkdownRenderer } from '../reporting/qa-plan-markdown.js';
import { PlanSchemaInvalidError } from './errors.js';
import type { Clock } from './ports.js';
import { PlanningCoverageAnalyzer } from './planning-coverage-analyzer.js';
import { PlanningGroundingValidator } from './planning-grounding-validator.js';
import { PlanningObservationCompiler } from './planning-observation-compiler.js';
import type {
  PlanningArtifactReader,
  PlanningArtifactWriter,
  QaReasoningProvider,
  ReasoningProviderResponse,
} from './planning-ports.js';
import { PlanningPromptBuilder } from './planning-prompt-builder.js';
import {
  PlanningExecutabilityPolicy,
  PlanningScenarioDeduplicator,
} from './planning-safety-policy.js';
import { parsePlanningResponse, PlanningSchemaValidationError } from './planning-schema.js';

export interface PlanQaOptions {
  readonly provider: 'openai-compatible';
  readonly model: string;
}

export interface PlanQaOutcome {
  readonly plan: QaPlan;
  readonly artifactDirectory: string;
  readonly sourceFile: string;
}

function aggregateUsage(
  responses: readonly ReasoningProviderResponse[],
): PlanningTokenUsage | null {
  const values = responses.flatMap((response) => (response.usage === null ? [] : [response.usage]));
  if (values.length === 0) return null;
  return values.reduce<PlanningTokenUsage>(
    (total, usage) => ({
      inputTokens: total.inputTokens + usage.inputTokens,
      outputTokens: total.outputTokens + usage.outputTokens,
      totalTokens: total.totalTokens + usage.totalTokens,
    }),
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  );
}

function planId(sourceRunId: string, scenarios: unknown): string {
  const digest = createHash('sha256').update(JSON.stringify(scenarios)).digest('hex').slice(0, 12);
  return `plan-${sourceRunId}-${digest}`.slice(0, 160);
}

export class PlanQa {
  private readonly compiler = new PlanningObservationCompiler();
  private readonly prompts = new PlanningPromptBuilder();
  private readonly schemaGrounding = new PlanningGroundingValidator();
  private readonly deduplicator = new PlanningScenarioDeduplicator();
  private readonly executability = new PlanningExecutabilityPolicy();
  private readonly coverage = new PlanningCoverageAnalyzer();
  private readonly markdown = new QaPlanMarkdownRenderer();

  public constructor(
    private readonly provider: QaReasoningProvider,
    private readonly reader: PlanningArtifactReader,
    private readonly writer: PlanningArtifactWriter,
    private readonly clock: Clock,
  ) {}

  public async execute(path: string, options: PlanQaOptions): Promise<PlanQaOutcome> {
    const loaded = await this.reader.loadExploration(path);
    const compiled = this.compiler.compile(loaded.exploration);
    const artifactDirectory = await this.writer.saveObservation(
      loaded.runDirectory,
      compiled.observation,
    );
    const prompt = this.prompts.build();
    const responses: ReasoningProviderResponse[] = [];
    let repairAttempts: 0 | 1 = 0;
    let response = await this.provider.generatePlan({
      prompt,
      observation: compiled.observation,
      repair: null,
    });
    responses.push(response);
    let proposal;
    try {
      proposal = parsePlanningResponse(response.content);
    } catch (error) {
      if (!(error instanceof PlanningSchemaValidationError)) throw error;
      repairAttempts = 1;
      response = await this.provider.generatePlan({
        prompt,
        observation: compiled.observation,
        repair: {
          validationErrors: error.validationErrors,
          invalidResponse: response.content,
        },
      });
      responses.push(response);
      try {
        proposal = parsePlanningResponse(response.content);
      } catch (repairError) {
        if (repairError instanceof PlanningSchemaValidationError) {
          throw new PlanSchemaInvalidError(repairError.validationErrors);
        }
        throw repairError;
      }
    }

    this.schemaGrounding.validate(proposal, compiled.catalog);
    const deduplicated = this.deduplicator.deduplicate(proposal.scenarios);
    const scenarios = deduplicated.scenarios.map((scenario) =>
      this.executability.apply(scenario, compiled.catalog),
    );
    const analyzed = this.coverage.analyze(
      scenarios,
      compiled.catalog,
      deduplicated.duplicatesRemoved,
    );
    const warnings = [...analyzed.warnings];
    if (compiled.observation.truncation.truncated) {
      warnings.push(
        `Planning input was deterministically truncated: ${compiled.observation.truncation.truncatedFields.join(', ')}.`,
      );
    }
    const plan: QaPlan = {
      schemaVersion: '1.0',
      planId: planId(loaded.exploration.runId, scenarios),
      sourceRunId: loaded.exploration.runId,
      generatedAt: this.clock.now().toISOString(),
      summary: proposal.summary,
      scenarios,
      coverage: analyzed.coverage,
      risks: proposal.risks,
      uncoveredAreas: [...new Set([...proposal.uncoveredAreas, ...analyzed.uncoveredAreas])].slice(
        0,
        100,
      ),
      warnings,
      metadata: {
        provider: options.provider,
        model: options.model,
        requestDurationMs: responses.reduce((total, item) => total + item.durationMs, 0),
        repairAttempts,
        inputTruncation: compiled.observation.truncation,
        usage: aggregateUsage(responses),
        duplicateScenariosRemoved: deduplicated.duplicatesRemoved,
      },
    };
    await this.writer.savePlan(loaded.runDirectory, plan, this.markdown.render(plan));
    return { plan, artifactDirectory, sourceFile: loaded.sourceFile };
  }
}
