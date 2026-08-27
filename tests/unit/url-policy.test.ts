import { describe, expect, it } from 'vitest';
import {
  canonicalizePageUrl,
  ConservativeNavigationSafetyPolicy,
  normalizeDiscoveredLink,
  QueryVariantLimiter,
  SameOriginScopePolicy,
} from '../../src/domain/url-policy.js';

describe('URL canonicalization', () => {
  it('resolves relative links and removes fragments', () => {
    expect(
      normalizeDiscoveredLink('../products#reviews', 'https://example.test/shop/cart'),
    ).toEqual({
      kind: 'page',
      url: 'https://example.test/products',
    });
  });

  it('keeps query strings and their ordering', () => {
    expect(canonicalizePageUrl('https://example.test/search?b=2&a=1#results')).toBe(
      'https://example.test/search?b=2&a=1',
    );
  });

  it('preserves non-root trailing slashes because servers may distinguish them', () => {
    expect(canonicalizePageUrl('https://example.test/products/')).toBe(
      'https://example.test/products/',
    );
    expect(canonicalizePageUrl('https://example.test')).toBe('https://example.test/');
  });

  it.each([
    '',
    'mailto:qa@example.test',
    'tel:+100000',
    'javascript:void(0)',
    'data:text/plain,x',
    'blob:https://example.test/id',
  ])('classifies "%s" as unsupported', (href) => {
    expect(normalizeDiscoveredLink(href, 'https://example.test/')).toEqual({
      kind: 'unsupported',
    });
  });
});

describe('SameOriginScopePolicy', () => {
  const policy = new SameOriginScopePolicy('https://example.test:8443/');

  it.each([
    ['https://example.test:8443/products', 'internal'],
    ['http://example.test:8443/products', 'external'],
    ['https://example.test/products', 'external'],
    ['https://sub.example.test:8443/products', 'external'],
  ] as const)('classifies %s as %s', (url, expected) => {
    expect(policy.classify(url)).toBe(expected);
  });
});

describe('QueryVariantLimiter', () => {
  it('limits unique query strings independently for each path', () => {
    const limiter = new QueryVariantLimiter(2);
    expect(limiter.accept('https://example.test/search?q=one')).toBe(true);
    expect(limiter.accept('https://example.test/search?q=one')).toBe(true);
    expect(limiter.accept('https://example.test/search?q=two')).toBe(true);
    expect(limiter.accept('https://example.test/search?q=three')).toBe(false);
    expect(limiter.accept('https://example.test/other?q=three')).toBe(true);
    expect(limiter.accept('https://example.test/search')).toBe(true);
  });
});

describe('ConservativeNavigationSafetyPolicy', () => {
  const policy = new ConservativeNavigationSafetyPolicy();

  it.each([
    'https://example.test/logout',
    'https://example.test/users/1/delete',
    'https://example.test/account?action=signout',
    'https://example.test/remove?id=1',
  ])('blocks potentially destructive navigation to %s', (url) => {
    expect(policy.allows(url)).toBe(false);
  });

  it('allows ordinary read-only routes and search values', () => {
    expect(policy.allows('https://example.test/products?q=how+to+remove+background')).toBe(true);
  });
});
