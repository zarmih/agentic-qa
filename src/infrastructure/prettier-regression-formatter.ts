import { format } from 'prettier';
import type { RegressionSourceFormatter } from '../application/regression-ports.js';

export class PrettierRegressionFormatter implements RegressionSourceFormatter {
  public format(source: string): Promise<string> {
    return format(source, {
      parser: 'typescript',
      printWidth: 100,
      semi: true,
      singleQuote: true,
      trailingComma: 'all',
      endOfLine: 'lf',
    });
  }
}
