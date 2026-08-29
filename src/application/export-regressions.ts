import { basename, posix } from 'node:path';
import type {
  ExportEntry,
  ExportEntryStatus,
  ExportPlan,
  ExportReceipt,
  ExportValidationResult,
} from '../domain/export.js';
import type { Clock, RunIdGenerator } from './ports.js';
import { ConfigurationError, ExportConflictError } from './errors.js';
import type {
  RegressionExportArtifactWriter,
  RegressionExportSourceReader,
  TargetExportFilesystem,
} from './export-ports.js';
import type { RegressionExportSourceValidator } from './regression-export-source-validator.js';
import type { TargetProjectInspector } from './target-project-inspector.js';

const MAX_DIFF_LINES = 80;

export interface ExportRegressionsOptions {
  readonly targetPath: string;
  readonly testsDirectory?: string;
  readonly apply: boolean;
  readonly overwrite: boolean;
  readonly validate: boolean;
  readonly validationTimeoutMs: number;
}

export interface ExportRegressionsOutcome {
  readonly plan: ExportPlan;
  readonly receipt: ExportReceipt | null;
  readonly artifactDirectory: string;
  readonly exitCode: 0 | 1;
}

function boundedLine(value: string): string {
  return Array.from(value)
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || (code >= 127 && code <= 159) ? '�' : character;
    })
    .join('')
    .slice(0, 500);
}

export function boundedUnifiedDiff(existing: string, generated: string, filename: string): string {
  const before = existing.split('\n');
  const after = generated.split('\n');
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const contextStart = Math.max(0, prefix - 3);
  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const suffixContext = before.slice(Math.max(prefix, before.length - Math.min(suffix, 3)));
  const lines = [`--- target/${filename}`, `+++ generated/${filename}`];
  for (let index = contextStart; index < prefix; index += 1) {
    lines.push(` ${boundedLine(before[index] ?? '')}`);
  }
  const fixedLines = lines.length + suffixContext.length;
  const changeBudget = Math.max(2, MAX_DIFF_LINES - fixedLines);
  const removedBudget = Math.max(1, Math.floor(changeBudget / 2));
  const addedBudget = Math.max(1, changeBudget - removedBudget);
  const removedLimit = Math.max(0, removedBudget - (removed.length > removedBudget ? 1 : 0));
  const addedLimit = Math.max(0, addedBudget - (added.length > addedBudget ? 1 : 0));
  for (const line of removed.slice(0, removedLimit)) {
    lines.push(`-${boundedLine(line)}`);
  }
  if (removed.length > removedLimit) {
    lines.push(`... ${String(removed.length - removedLimit)} removed lines omitted ...`);
  }
  for (const line of added.slice(0, addedLimit)) {
    lines.push(`+${boundedLine(line)}`);
  }
  if (added.length > addedLimit) {
    lines.push(`... ${String(added.length - addedLimit)} added lines omitted ...`);
  }
  lines.push(...suffixContext.map((line) => ` ${boundedLine(line)}`));
  return lines.join('\n');
}

function emptyValidation(): ExportValidationResult {
  return {
    requested: false,
    status: 'NOT_REQUESTED',
    command: [],
    durationMs: 0,
    output: '',
  };
}

export class ExportRegressions {
  public constructor(
    private readonly reader: RegressionExportSourceReader,
    private readonly sourceValidator: RegressionExportSourceValidator,
    private readonly inspector: TargetProjectInspector,
    private readonly target: TargetExportFilesystem,
    private readonly artifacts: RegressionExportArtifactWriter,
    private readonly runIds: RunIdGenerator,
    private readonly clock: Clock,
  ) {}

  public async execute(
    manifestPath: string,
    options: ExportRegressionsOptions,
  ): Promise<ExportRegressionsOutcome> {
    if (options.overwrite && !options.apply) {
      throw new ConfigurationError('--overwrite requires --apply.');
    }
    if (options.validate && !options.apply) {
      throw new ConfigurationError('--validate requires --apply.');
    }
    const loaded = await this.reader.loadExportSource(manifestPath);
    const validated = await this.sourceValidator.validate(loaded);
    const inspected = await this.inspector.inspect(
      options.targetPath,
      options.testsDirectory,
      loaded.manifest.options.targetOrigin,
    );
    const createdAt = this.clock.now();
    const exportId = `export-${this.runIds.next(createdAt)}`;
    const entries: ExportEntry[] = [];
    for (const manifestEntry of loaded.manifest.tests) {
      if (manifestEntry.file === null || manifestEntry.fileDigest === null) continue;
      const source = loaded.generatedFiles.get(manifestEntry.file);
      if (source === undefined) {
        throw new ExportConflictError(
          `Validated generated source is missing: ${manifestEntry.file}.`,
        );
      }
      const destination = posix.join(
        inspected.profile.destinationDirectory,
        basename(manifestEntry.file),
      );
      const existing = await this.target.inspectDestination(inspected.rootPath, destination);
      const status: ExportEntryStatus = !existing.exists
        ? 'NEW'
        : existing.digest === manifestEntry.fileDigest
          ? 'IDENTICAL'
          : existing.generatedByAgenticQa
            ? 'MODIFIED_GENERATED'
            : 'CONFLICT';
      entries.push({
        findingId: manifestEntry.findingId,
        source: manifestEntry.file,
        destination,
        status,
        sourceDigest: manifestEntry.fileDigest,
        existingDigest: existing.digest,
        diff:
          existing.contents === null || status === 'IDENTICAL'
            ? null
            : boundedUnifiedDiff(existing.contents, source, destination),
        willWrite: status === 'NEW' || (options.overwrite && status !== 'IDENTICAL'),
        reason:
          status === 'NEW'
            ? 'New dedicated Agentic QA regression file.'
            : status === 'IDENTICAL'
              ? 'Target bytes already match the generated SHA-256.'
              : status === 'MODIFIED_GENERATED'
                ? 'An Agentic QA generated file exists but its bytes differ.'
                : 'A non-identical existing target file conflicts with this export.',
      });
    }
    const statusCount = (status: ExportEntryStatus) =>
      entries.filter((entry) => entry.status === status).length;
    const warnings = [...validated.warnings, ...inspected.profile.warnings];
    if (inspected.profile.baseUrlCompatibility === 'BASE_URL_REVIEW_REQUIRED') {
      warnings.push(
        `Generated origin ${loaded.manifest.options.targetOrigin} differs from the statically detected target baseURL.`,
      );
    }
    const blocked =
      entries.filter(
        (entry) => ['CONFLICT', 'MODIFIED_GENERATED'].includes(entry.status) && !options.overwrite,
      ).length + (inspected.profile.support === 'UNSUPPORTED' ? entries.length : 0);
    const plan: ExportPlan = {
      schemaVersion: '1.0',
      exportId,
      generationId: loaded.manifest.generationId,
      createdAt: createdAt.toISOString(),
      mode: options.apply ? 'APPLY' : 'DRY_RUN',
      options: { overwrite: options.overwrite, validate: options.validate },
      target: inspected.profile,
      entries,
      summary: {
        specs: entries.length,
        newFiles: statusCount('NEW'),
        identical: statusCount('IDENTICAL'),
        modifiedGenerated: statusCount('MODIFIED_GENERATED'),
        conflicts: statusCount('CONFLICT'),
        changesToApply: entries.filter((entry) => entry.willWrite).length,
        blocked,
      },
      warnings,
      sourceIntegrity: {
        algorithm: 'SHA-256',
        manifestDigest: validated.manifestDigest,
        generationPayloadDigest: validated.generationPayloadDigest,
      },
    };
    const exportDirectory = await this.artifacts.savePlan(loaded.generationDirectory, plan);
    if (!options.apply) {
      return {
        plan,
        receipt: null,
        artifactDirectory: exportDirectory,
        exitCode:
          inspected.profile.support === 'SUPPORTED' && blocked === 0 && warnings.length === 0
            ? 0
            : 1,
      };
    }
    if (inspected.profile.support === 'UNSUPPORTED') {
      throw new ExportConflictError(
        'Target is unsupported for automatic apply; no target files were written.',
      );
    }
    const files = await this.target.apply(
      inspected.rootPath,
      entries,
      loaded.generatedFiles,
      options.overwrite,
    );
    const destinations = files.flatMap((entry) =>
      entry.action === 'SKIPPED' ? [] : [entry.destination],
    );
    const validation = options.validate
      ? await this.target.validate(
          inspected.rootPath,
          inspected.profile.packageManager,
          destinations,
          options.validationTimeoutMs,
        )
      : emptyValidation();
    const gitReview = await this.target.gitReview(inspected.rootPath, destinations);
    const receipt: ExportReceipt = {
      schemaVersion: '1.0',
      exportId,
      generationId: loaded.manifest.generationId,
      appliedAt: this.clock.now().toISOString(),
      targetIdentifier: inspected.profile.identifier,
      files,
      validation,
      gitReview,
      warnings,
    };
    await this.artifacts.saveReceipt(exportDirectory, receipt);
    return {
      plan,
      receipt,
      artifactDirectory: exportDirectory,
      exitCode:
        blocked > 0 ||
        validation.status === 'FAIL' ||
        validation.status === 'NOT_AVAILABLE' ||
        inspected.profile.support !== 'SUPPORTED'
          ? 1
          : 0,
    };
  }
}
