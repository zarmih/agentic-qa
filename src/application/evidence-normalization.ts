const UUID_PATTERN =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const ISO_TIMESTAMP_PATTERN = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z\b/gi;
const RUN_ID_PATTERN = /\b\d{8}T\d{9}Z-[0-9a-f]{8}\b/gi;
const LONG_HEX_PATTERN = /\b[0-9a-f]{16,}\b/gi;
const LONG_NUMBER_PATTERN = /\b\d{6,}\b/g;
const LOCAL_PORT_PATTERN = /(https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\])):\d+/gi;

export function normalizeDiagnosticText(value: string): string {
  return value
    .replaceAll(UUID_PATTERN, '<uuid>')
    .replaceAll(ISO_TIMESTAMP_PATTERN, '<timestamp>')
    .replaceAll(RUN_ID_PATTERN, '<run-id>')
    .replaceAll(LOCAL_PORT_PATTERN, '$1:<port>')
    .replaceAll(LONG_HEX_PATTERN, '<hex-id>')
    .replaceAll(LONG_NUMBER_PATTERN, '<number>')
    .trim()
    .replaceAll(/\s+/g, ' ')
    .toLowerCase();
}

export function normalizeEvidenceUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    url.hash = '';
    const sorted = [...url.searchParams.entries()].sort(
      ([leftKey, leftValue], [rightKey, rightValue]) =>
        leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    );
    url.search = '';
    for (const [key, item] of sorted) url.searchParams.append(key, item);
    const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname.toLowerCase());
    const authority = local
      ? `${url.protocol}//${url.hostname.toLowerCase()}${url.port === '' ? '' : ':<port>'}`
      : `${url.protocol}//${url.host.toLowerCase()}`;
    return `${authority}${url.pathname}${url.search}`;
  } catch {
    return normalizeDiagnosticText(value);
  }
}
