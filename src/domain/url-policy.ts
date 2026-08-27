export type NormalizedLink =
  { readonly kind: 'page'; readonly url: string } | { readonly kind: 'unsupported' };

const SUPPORTED_PROTOCOLS = new Set(['http:', 'https:']);

export function canonicalizePageUrl(value: string, base?: string): string {
  const url = base === undefined ? new URL(value) : new URL(value, base);
  if (!SUPPORTED_PROTOCOLS.has(url.protocol) || !url.hostname) {
    throw new TypeError(`Unsupported page URL: ${value}`);
  }
  url.hash = '';
  return url.href;
}

export function normalizeDiscoveredLink(href: string, baseUrl: string): NormalizedLink {
  const value = href.trim();
  if (value === '') return { kind: 'unsupported' };

  try {
    return { kind: 'page', url: canonicalizePageUrl(value, baseUrl) };
  } catch {
    return { kind: 'unsupported' };
  }
}

export interface ScopePolicy {
  classify(url: string): 'internal' | 'external';
}

export interface NavigationSafetyPolicy {
  allows(url: string): boolean;
}

const DESTRUCTIVE_TOKENS = new Set([
  'buy',
  'delete',
  'destroy',
  'logout',
  'purchase',
  'remove',
  'signout',
  'unsubscribe',
]);

function tokens(value: string): readonly string[] {
  try {
    return decodeURIComponent(value)
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  } catch {
    return value
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
  }
}

export class ConservativeNavigationSafetyPolicy implements NavigationSafetyPolicy {
  public allows(urlValue: string): boolean {
    const url = new URL(canonicalizePageUrl(urlValue));
    if (tokens(url.pathname).some((token) => DESTRUCTIVE_TOKENS.has(token))) return false;

    for (const [key, value] of url.searchParams) {
      if (DESTRUCTIVE_TOKENS.has(key.toLowerCase())) return false;
      if (
        ['action', 'do', 'operation'].includes(key.toLowerCase()) &&
        tokens(value).some((token) => DESTRUCTIVE_TOKENS.has(token))
      ) {
        return false;
      }
    }
    return true;
  }
}

export class SameOriginScopePolicy implements ScopePolicy {
  private readonly origin: string;

  public constructor(startUrl: string) {
    this.origin = new URL(canonicalizePageUrl(startUrl)).origin;
  }

  public classify(url: string): 'internal' | 'external' {
    return new URL(canonicalizePageUrl(url)).origin === this.origin ? 'internal' : 'external';
  }
}

export class QueryVariantLimiter {
  private readonly variants = new Map<string, Set<string>>();

  public constructor(private readonly maximumPerPath: number) {}

  public accept(urlValue: string): boolean {
    const url = new URL(urlValue);
    if (url.search === '') return true;

    const key = `${url.origin}${url.pathname}`;
    const variants = this.variants.get(key) ?? new Set<string>();
    if (variants.has(url.search)) return true;
    if (variants.size >= this.maximumPerPath) return false;

    variants.add(url.search);
    this.variants.set(key, variants);
    return true;
  }
}
