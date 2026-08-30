import type { ExplorationOutcome, ExploreApplicationOptions } from './explore-application.js';
import type { PlanQaOptions, PlanQaOutcome } from './plan-qa.js';
import type { RunQaPlanOptions, RunQaPlanOutcome } from './run-qa-plan.js';
import type { VerifyExecutionOptions, VerifyExecutionOutcome } from './verify-execution.js';
import type {
  GenerateRegressionsOptions,
  GenerateRegressionsOutcome,
} from './generate-regressions.js';
import type { PipelineRun } from '../domain/pipeline.js';
import type { SavedRegressionManifest } from '../domain/regression.js';

export interface PipelineExplorer {
  execute(url: string, options: ExploreApplicationOptions): Promise<ExplorationOutcome>;
}

export interface PipelinePlanner {
  execute(path: string, options: PlanQaOptions): Promise<PlanQaOutcome>;
}

export interface PipelineRunner {
  execute(path: string, options: RunQaPlanOptions): Promise<RunQaPlanOutcome>;
}

export interface PipelineVerifier {
  execute(path: string, options: VerifyExecutionOptions): Promise<VerifyExecutionOutcome>;
}

export interface PipelineGenerator {
  execute(path: string, options: GenerateRegressionsOptions): Promise<GenerateRegressionsOutcome>;
}

export interface PipelineReportData {
  readonly pipeline: PipelineRun;
  readonly exploration: ExplorationOutcome['result'] | null;
  readonly plan: PlanQaOutcome['plan'] | null;
  readonly execution: RunQaPlanOutcome['result'] | null;
  readonly verification: VerifyExecutionOutcome['result'] | null;
  readonly manifest: SavedRegressionManifest | null;
}

export interface PipelineHtmlRenderer {
  render(data: PipelineReportData): string;
}

export interface PipelineArtifactWriter {
  save(runDirectory: string, pipeline: PipelineRun, html: string): Promise<void>;
}

export interface PipelineReportSourceReader {
  load(path: string): Promise<{ readonly runDirectory: string; readonly data: PipelineReportData }>;
}
