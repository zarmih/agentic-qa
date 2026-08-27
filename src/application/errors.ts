export type ErrorCode =
  | 'INVALID_CONFIG'
  | 'ARTIFACT_WRITE_FAILED'
  | 'BROWSER_STARTUP_FAILED'
  | 'NAVIGATION_TIMEOUT'
  | 'NAVIGATION_FAILED';

export class AgenticQaError extends Error {
  public constructor(
    public readonly code: ErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class ConfigurationError extends AgenticQaError {
  public constructor(message: string) {
    super('INVALID_CONFIG', message);
  }
}

export class ArtifactWriteError extends AgenticQaError {
  public constructor(path: string, cause: unknown) {
    super(
      'ARTIFACT_WRITE_FAILED',
      `Could not create or write the artifacts directory at "${path}". Check the path and permissions.`,
      { cause },
    );
  }
}

export class BrowserStartupError extends AgenticQaError {
  public constructor(cause: unknown) {
    super(
      'BROWSER_STARTUP_FAILED',
      'Chromium could not start. Run "npx playwright install chromium" and try again.',
      { cause },
    );
  }
}

export class NavigationTimeoutError extends AgenticQaError {
  public constructor(url: string, timeoutMs: number, cause: unknown) {
    super(
      'NAVIGATION_TIMEOUT',
      `Navigation to ${url} timed out after ${String(timeoutMs)} ms. Increase AGENTIC_QA_NAVIGATION_TIMEOUT_MS or use --timeout.`,
      { cause },
    );
  }
}

export class NavigationFailedError extends AgenticQaError {
  public constructor(url: string, cause: unknown) {
    super(
      'NAVIGATION_FAILED',
      `Could not reach ${url}. Check the address, network connection, and host availability.`,
      { cause },
    );
  }
}
