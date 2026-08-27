export class InvalidUrlError extends Error {
  public constructor(value: string) {
    super(`Invalid URL: "${value}". Provide an absolute http:// or https:// URL.`);
    this.name = 'InvalidUrlError';
  }
}

export function parseTargetUrl(value: string): string {
  const input = value.trim();

  let url: URL;
  try {
    url = new URL(input);
  } catch {
    throw new InvalidUrlError(value);
  }

  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
    throw new InvalidUrlError(value);
  }

  return url.href;
}
