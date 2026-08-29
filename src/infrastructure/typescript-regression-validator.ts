import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import ts from 'typescript';
import { RegressionGenerationError } from '../application/errors.js';
import type { RegressionSourceCodeValidator } from '../application/regression-ports.js';

export class TypeScriptRegressionValidator implements RegressionSourceCodeValidator {
  public validate(fileName: string, source: string): void {
    const packageJson = createRequire(import.meta.url).resolve('playwright/package.json');
    const playwrightTypes = join(dirname(packageJson), 'types', 'test.d.ts');
    const virtualFile = join('/__agentic_qa_generated__', basename(fileName));
    const options: ts.CompilerOptions = {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      baseUrl: '/',
      paths: { '@playwright/test': [playwrightTypes] },
      ignoreDeprecations: '6.0',
    };
    const host = ts.createCompilerHost(options);
    const originalGetSourceFile = host.getSourceFile.bind(host);
    const originalReadFile = host.readFile.bind(host);
    const originalFileExists = host.fileExists.bind(host);
    host.fileExists = (path) => path === virtualFile || originalFileExists(path);
    host.readFile = (path) => (path === virtualFile ? source : originalReadFile(path));
    host.getSourceFile = (path, languageVersion, onError, shouldCreateNewSourceFile) =>
      path === virtualFile
        ? ts.createSourceFile(path, source, languageVersion, true, ts.ScriptKind.TS)
        : originalGetSourceFile(path, languageVersion, onError, shouldCreateNewSourceFile);
    const program = ts.createProgram([virtualFile], options, host);
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length > 0) {
      const message = ts.formatDiagnosticsWithColorAndContext(diagnostics.slice(0, 20), {
        getCanonicalFileName: (path) => path,
        getCurrentDirectory: () => '/',
        getNewLine: () => '\n',
      });
      throw new RegressionGenerationError(
        `Generated Playwright test ${fileName} failed TypeScript validation.`,
        { cause: new Error(message) },
      );
    }
  }
}
