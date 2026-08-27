import { describe, expect, it } from 'vitest';
import { InvalidUrlError, parseTargetUrl } from '../../src/domain/target-url.js';

describe('parseTargetUrl', () => {
  it('normalizes an absolute HTTPS URL', () => {
    expect(parseTargetUrl(' https://example.com/path ')).toBe('https://example.com/path');
  });

  it.each(['example.com', '', 'ftp://example.com', '/relative'])('rejects "%s"', (value) => {
    expect(() => parseTargetUrl(value)).toThrow(InvalidUrlError);
  });
});
