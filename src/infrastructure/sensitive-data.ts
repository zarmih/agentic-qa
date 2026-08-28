export function redactSensitiveText(value: string, sensitiveValues: readonly string[]): string {
  return sensitiveValues
    .filter((secret) => secret.length > 0)
    .reduce((result, secret) => result.replaceAll(secret, '[REDACTED]'), value);
}
