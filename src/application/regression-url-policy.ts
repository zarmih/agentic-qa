import { ConfigurationError, RegressionGenerationError } from './errors.js';
import { ConservativeNavigationSafetyPolicy, SameOriginScopePolicy } from '../domain/url-policy.js';

export class RegressionUrlPolicy {
  private readonly sourceOrigin: string;
  private readonly target: URL;
  private readonly scope: SameOriginScopePolicy;
  private readonly navigation = new ConservativeNavigationSafetyPolicy();

  public constructor(startUrl: string, baseUrl?: string) {
    const source = new URL(startUrl);
    this.sourceOrigin = source.origin;
    this.scope = new SameOriginScopePolicy(startUrl);
    const rawTarget = baseUrl ?? source.origin;
    let target: URL;
    try {
      target = new URL(rawTarget);
    } catch {
      throw new ConfigurationError('--base-url must be an absolute HTTP(S) origin.');
    }
    if (
      !['http:', 'https:'].includes(target.protocol) ||
      target.username !== '' ||
      target.password !== '' ||
      target.pathname !== '/' ||
      target.search !== '' ||
      target.hash !== ''
    ) {
      throw new ConfigurationError(
        '--base-url must contain only an HTTP(S) origin, without credentials, path, query, or fragment.',
      );
    }
    this.target = target;
  }

  public get targetOrigin(): string {
    return this.target.origin;
  }

  public apply(graphUrl: string): string {
    let source: URL;
    try {
      source = new URL(graphUrl);
    } catch {
      throw new RegressionGenerationError('A graph-owned URL is malformed.');
    }
    if (
      source.origin !== this.sourceOrigin ||
      this.scope.classify(source.href) !== 'internal' ||
      !this.navigation.allows(source.href)
    ) {
      throw new RegressionGenerationError('A graph-owned URL is outside the source safety policy.');
    }
    const substituted = new URL(`${source.pathname}${source.search}`, this.target);
    substituted.hash = '';
    return substituted.href;
  }
}
