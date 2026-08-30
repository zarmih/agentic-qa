import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import ts from 'typescript';
import { RegressionGenerationError } from '../application/errors.js';
import type { RegressionSourceCodeValidator } from '../application/regression-ports.js';

export class TypeScriptRegressionValidator implements RegressionSourceCodeValidator {
  public validate(fileName: string, source: string): void {
    const packageJson = createRequire(import.meta.url).resolve('playwright/package.json');
    const playwrightTypes = join(dirname(packageJson), 'types', 'test.d.ts');
    const virtualFile = resolve(process.cwd(), '__agentic_qa_generated__', basename(fileName));
    const canonicalFileName = (path: string): string => {
      const normalized = resolve(path).replaceAll('\\', '/');
      return ts.sys.useCaseSensitiveFileNames ? normalized : normalized.toLowerCase();
    };
    const virtualFileName = canonicalFileName(virtualFile);
    const isVirtualFile = (path: string): boolean => canonicalFileName(path) === virtualFileName;
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      baseUrl: process.cwd(),
      paths: { '@playwright/test': [playwrightTypes] },
      ignoreDeprecations: '6.0',
    };
    const host = ts.createCompilerHost(options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    const originalReadFile = host.readFile.bind(host);
    const originalFileExists = host.fileExists.bind(host);
    host.fileExists = (path) => isVirtualFile(path) || originalFileExists(path);
    host.readFile = (path) => (isVirtualFile(path) ? source : originalReadFile(path));
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
      isVirtualFile(path)
        ? ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.TS)
        : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([virtualFile], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      const message = ts.formatDiagnosticsWithColorAndContext(diagnostics.slice(0, 20), {
        getCanonicalFileName: canonicalFileName,
        getCurrentDirectory: () => process.cwd(),
        getNewLine: () => '\n',
      });
      throw new RegressionGenerationError(
        `Generated Playwright test ${fileName} failed TypeScript validation.`,
        { cause: new Error(message) },
      );
    }
  }
}
