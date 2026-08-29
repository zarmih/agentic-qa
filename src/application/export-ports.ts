import type {
  ExportEntry,
  ExportPlan,
  ExportReceipt,
  ExportReceiptEntry,
  ExportValidationResult,
  PackageManager,
  TargetProjectProfile,
} from '../domain/export.js';
import type { SavedRegressionManifest } from '../domain/regression.js';
import type { LoadedRegressionSource } from './regression-ports.js';

export interface LoadedRegressionExportSource {
  readonly manifest: SavedRegressionManifest;
  readonly manifestFile: string;
  readonly generationDirectory: string;
  readonly runDirectory: string;
  readonly regressionSource: LoadedRegressionSource;
  readonly generatedFiles: ReadonlyMap<string, string>;
}

export interface RegressionExportSourceReader {
  loadExportSource(manifestPath: string): Promise<LoadedRegressionExportSource>;
}

export interface TargetProjectFacts {
  readonly rootPath: string;
  readonly identifier: string;
  readonly packageJson: boolean;
  readonly packageManager: PackageManager;
  readonly playwrightDependency: boolean;
  readonly playwrightConfig: string | null;
  readonly configuredTestDirectory: string | null;
  readonly configuredBaseUrl: string | null;
  readonly tsconfig: boolean;
  readonly moduleType: 'module' | 'commonjs' | 'unspecified';
  readonly language: 'typescript' | 'javascript' | 'unknown';
  readonly existingTestDirectories: readonly string[];
  readonly git: TargetProjectProfile['git'];
  readonly warnings: readonly string[];
}

export interface TargetProjectProbe {
  inspect(targetPath: string): Promise<TargetProjectFacts>;
}

export interface ExistingTargetFile {
  readonly exists: boolean;
  readonly digest: string | null;
  readonly contents: string | null;
  readonly generatedByAgenticQa: boolean;
}

export interface TargetExportFilesystem {
  inspectDestination(rootPath: string, relativePath: string): Promise<ExistingTargetFile>;
  apply(
    rootPath: string,
    entries: readonly ExportEntry[],
    sources: ReadonlyMap<string, string>,
    overwrite: boolean,
  ): Promise<readonly ExportReceiptEntry[]>;
  validate(
    rootPath: string,
    packageManager: PackageManager,
    destinations: readonly string[],
    timeoutMs: number,
  ): Promise<ExportValidationResult>;
  gitReview(rootPath: string, destinations: readonly string[]): Promise<readonly string[]>;
}

export interface RegressionExportArtifactWriter {
  savePlan(generationDirectory: string, plan: ExportPlan): Promise<string>;
  saveReceipt(exportDirectory: string, receipt: ExportReceipt): Promise<void>;
}
