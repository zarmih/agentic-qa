import { randomUUID } from 'node:crypto';
import { lstat, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ArtifactWriteError, ReportSourceError } from '../application/errors.js';
import type {
  PipelineArtifactWriter,
  PipelineReportData,
  PipelineReportSourceReader,
} from '../application/pipeline-ports.js';
import {
  parseSavedPipeline,
  SavedPipelineValidationError,
} from '../application/pipeline-schema.js';
import { parseSavedQaPlan, SavedPlanValidationError } from '../application/planning-schema.js';
import {
  parseSavedExecution,
  SavedExecutionValidationError,
} from '../application/execution-schema.js';
import {
  parseSavedFindings,
  parseSavedVerification,
  SavedVerificationValidationError,
} from '../application/verification-schema.js';
import {
  parseSavedRegressionManifest,
  SavedRegressionManifestValidationError,
} from '../application/regression-schema.js';
import type { PipelineRun } from '../domain/pipeline.js';
import type { FindingsArtifact, VerificationRun } from '../domain/verification.js';
import type { ExecutionRun } from '../domain/execution.js';
import type { QaPlan } from '../domain/planning.js';
import { canonicalJson, sha256Digest } from '../application/source-integrity.js';
import { ExecutionIntegrityService } from '../application/execution-integrity.js';
import {
  FindingsIntegrityService,
  VerificationIntegrityService,
} from '../application/verification-integrity.js';
import { RegressionManifestIntegrityService } from '../application/regression-integrity.js';
import { FilePlanningArtifacts } from './file-planning-artifacts.js';

const MAX_JSON_BYTES = 50 * 1024 * 1024;
const MAX_HTML_BYTES = 20 * 1024 * 1024;

function contained(root: string, candidate: string): boolean {
  const value = relative(root, candidate);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..');
}

async function regularFile(path: string, maximumBytes: number): Promise<string> {
  const details = await lstat(path);
  if (details.isSymbolicLink() || !details.isFile() || details.size > maximumBytes) {
    throw new Error('not a bounded regular file');
  }
  return readFile(path, 'utf8');
}

async function json(path: string): Promise<unknown> {
  try {
    return JSON.parse(await regularFile(path, MAX_JSON_BYTES)) as unknown;
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ReportSourceError(`Report source "${basename(path)}" is not valid JSON.`);
    }
    if (error instanceof ReportSourceError) throw error;
    throw new ReportSourceError(`Could not read bounded report source "${basename(path)}".`);
  }
}

function referenced(runDirectory: string, value: string): string {
  if (isAbsolute(value) || value.includes('\0') || value.includes('\\')) {
    throw new ReportSourceError('Pipeline artifact references must be safe relative paths.');
  }
  const candidate = resolve(runDirectory, value);
  if (!contained(runDirectory, candidate)) {
    throw new ReportSourceError('Pipeline artifact reference escapes the source run directory.');
  }
  return candidate;
}

function pipelineFile(pathValue: string): string {
  const candidate = resolve(pathValue);
  return basename(candidate) === 'pipeline.json' ? candidate : join(candidate, 'pipeline.json');
}

export class FilePipelineArtifacts implements PipelineArtifactWriter, PipelineReportSourceReader {
  public async save(runDirectoryValue: string, pipeline: PipelineRun, html: string): Promise<void> {
    const runDirectory = resolve(runDirectoryValue);
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      throw new ReportSourceError('Rendered report exceeds the 20 MiB safety limit.');
    }
    try {
      await Promise.all([
        this.atomicWrite(
          join(runDirectory, 'pipeline.json'),
          `${JSON.stringify(pipeline, null, 2)}\n`,
        ),
        this.atomicWrite(join(runDirectory, 'report.html'), html),
      ]);
    } catch (error) {
      throw new ArtifactWriteError(runDirectory, error);
    }
  }

  public async load(
    pathValue: string,
  ): Promise<{ readonly runDirectory: string; readonly data: PipelineReportData }> {
    const source = pipelineFile(pathValue);
    const runDirectory = dirname(source);
    let pipeline: PipelineRun;
    try {
      pipeline = parseSavedPipeline(await json(source));
    } catch (error) {
      if (error instanceof ReportSourceError) throw error;
      if (error instanceof SavedPipelineValidationError) {
        throw new ReportSourceError(error.message);
      }
      throw error;
    }
    if (pipeline.pipelineId !== `pipeline-${pipeline.sourceRunId}`) {
      throw new ReportSourceError('pipelineId does not match sourceRunId.');
    }

    const exploration =
      pipeline.artifacts.exploration === null
        ? null
        : (
            await new FilePlanningArtifacts().loadExploration(
              referenced(runDirectory, pipeline.artifacts.exploration),
            )
          ).exploration;
    if (exploration !== null && exploration.runId !== pipeline.sourceRunId) {
      throw new ReportSourceError('Exploration and pipeline source run identifiers do not match.');
    }

    try {
      const plan =
        pipeline.artifacts.plan === null
          ? null
          : parseSavedQaPlan(await json(referenced(runDirectory, pipeline.artifacts.plan)));
      const execution =
        pipeline.artifacts.execution === null
          ? null
          : parseSavedExecution(await json(referenced(runDirectory, pipeline.artifacts.execution)));
      const verification =
        pipeline.artifacts.verification === null
          ? null
          : parseSavedVerification(
              await json(referenced(runDirectory, pipeline.artifacts.verification)),
            );
      const manifest =
        pipeline.artifacts.manifest === null
          ? null
          : parseSavedRegressionManifest(
              await json(referenced(runDirectory, pipeline.artifacts.manifest)),
            );
      const findings =
        pipeline.artifacts.findings === null
          ? null
          : parseSavedFindings(await json(referenced(runDirectory, pipeline.artifacts.findings)));
      for (const item of [plan, execution, verification, manifest]) {
        if (item !== null && item.sourceRunId !== pipeline.sourceRunId) {
          throw new ReportSourceError('A report artifact belongs to a different source run.');
        }
      }
      await this.validateIntegrity(
        runDirectory,
        pipeline,
        exploration,
        plan,
        execution,
        verification,
        findings,
        manifest,
      );
      return {
        runDirectory,
        data: { pipeline, exploration, plan, execution, verification, manifest },
      };
    } catch (error) {
      if (error instanceof ReportSourceError) throw error;
      if (
        error instanceof SavedPlanValidationError ||
        error instanceof SavedExecutionValidationError ||
        error instanceof SavedVerificationValidationError ||
        error instanceof SavedRegressionManifestValidationError
      ) {
        throw new ReportSourceError(error.message);
      }
      throw error;
    }
  }

  private async validateIntegrity(
    runDirectory: string,
    pipeline: PipelineRun,
    exploration: PipelineReportData['exploration'],
    plan: QaPlan | null,
    execution: ExecutionRun | null,
    verification: VerificationRun | null,
    findings: FindingsArtifact | null,
    manifest: PipelineReportData['manifest'],
  ): Promise<void> {
    if (plan !== null) {
      if (exploration === null) {
        throw new ReportSourceError('A report plan cannot exist without exploration data.');
      }
      const observation = await json(join(runDirectory, 'planning', 'observation.json'));
      const graph = await json(join(runDirectory, 'graph.json'));
      const stateGraph = await json(join(runDirectory, 'state-graph.json'));
      const expected = {
        algorithm: 'SHA-256',
        explorationDigest: sha256Digest(exploration),
        observationDigest: sha256Digest(observation),
        graphDigest: sha256Digest(graph),
        stateGraphDigest: sha256Digest(stateGraph),
      };
      if (canonicalJson(expected) !== canonicalJson(plan.metadata.sourceIntegrity)) {
        throw new ReportSourceError(
          'Planning source-integrity digests do not match report artifacts.',
        );
      }
    }
    if (execution !== null) {
      if (!new ExecutionIntegrityService().validate(execution) || plan === null) {
        throw new ReportSourceError(
          'Execution payload integrity is invalid or its plan is missing.',
        );
      }
      if (
        execution.sourceIntegrity.planDigest !== sha256Digest(plan) ||
        canonicalJson({
          algorithm: execution.sourceIntegrity.algorithm,
          explorationDigest: execution.sourceIntegrity.explorationDigest,
          observationDigest: execution.sourceIntegrity.observationDigest,
          graphDigest: execution.sourceIntegrity.graphDigest,
          stateGraphDigest: execution.sourceIntegrity.stateGraphDigest,
        }) !== canonicalJson(plan.metadata.sourceIntegrity)
      ) {
        throw new ReportSourceError('Execution linkage does not match the report plan.');
      }
    }
    if (verification !== null) {
      if (
        !new VerificationIntegrityService().validate(verification) ||
        execution === null ||
        verification.sourceIntegrity.sourceExecutionDigest !== sha256Digest(execution)
      ) {
        throw new ReportSourceError('Verification payload or source execution linkage is invalid.');
      }
    }
    if (findings !== null) {
      if (
        !new FindingsIntegrityService().validate(findings) ||
        verification === null ||
        findings.sourceIntegrity.verificationDigest !== sha256Digest(verification)
      ) {
        throw new ReportSourceError('Findings payload or verification linkage is invalid.');
      }
    }
    if (manifest !== null) {
      if (
        manifest.schemaVersion !== '1.1' ||
        !new RegressionManifestIntegrityService().validate(manifest) ||
        findings === null ||
        manifest.sourceIntegrity.findingsDigest !== sha256Digest(findings) ||
        manifest.generationId !== pipeline.artifacts.generation?.split('/').at(-1)
      ) {
        throw new ReportSourceError('Regression manifest payload or findings linkage is invalid.');
      }
    }
  }

  public async saveRenderedReport(runDirectoryValue: string, html: string): Promise<string> {
    const runDirectory = resolve(runDirectoryValue);
    if (Buffer.byteLength(html, 'utf8') > MAX_HTML_BYTES) {
      throw new ReportSourceError('Rendered report exceeds the 20 MiB safety limit.');
    }
    const path = join(runDirectory, 'report.html');
    try {
      await this.atomicWrite(path, html);
    } catch (error) {
      throw new ArtifactWriteError(path, error);
    }
    return path;
  }

  private async atomicWrite(path: string, contents: string): Promise<void> {
    const temporary = `${path}.tmp-${String(process.pid)}-${randomUUID()}`;
    try {
      await writeFile(temporary, contents, { encoding: 'utf8', flag: 'w' });
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
}
