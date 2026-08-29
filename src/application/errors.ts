export type ErrorCode =
  | 'INVALID_CONFIG'
  | 'ARTIFACT_WRITE_FAILED'
  | 'BROWSER_STARTUP_FAILED'
  | 'NAVIGATION_TIMEOUT'
  | 'NAVIGATION_FAILED'
  | 'PLANNING_SOURCE_INVALID'
  | 'PROVIDER_AUTH_FAILED'
  | 'PROVIDER_RATE_LIMITED'
  | 'PROVIDER_TIMEOUT'
  | 'PROVIDER_BAD_RESPONSE'
  | 'PLAN_SCHEMA_INVALID'
  | 'PLAN_GROUNDING_INVALID'
  | 'EXECUTION_SOURCE_INVALID'
  | 'EXECUTION_INTEGRITY_INVALID'
  | 'EXECUTION_PLAN_INVALID'
  | 'VERIFICATION_SOURCE_INVALID'
  | 'VERIFICATION_INTEGRITY_INVALID'
  | 'REGRESSION_SOURCE_INVALID'
  | 'REGRESSION_INTEGRITY_INVALID'
  | 'REGRESSION_GENERATION_FAILED'
  | 'EXPORT_SOURCE_INVALID'
  | 'EXPORT_TARGET_UNSAFE'
  | 'EXPORT_CONFLICT'
  | 'EXPORT_WRITE_FAILED'
  | 'EXPORT_VALIDATION_FAILED'
  | 'PIPELINE_FAILED'
  | 'REPORT_SOURCE_INVALID';

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

export class PlanningSourceError extends AgenticQaError {
  public constructor(message: string) {
    super('PLANNING_SOURCE_INVALID', message);
  }
}

export class ProviderAuthenticationError extends AgenticQaError {
  public constructor() {
    super(
      'PROVIDER_AUTH_FAILED',
      'The reasoning provider rejected authentication. Check the configured API key.',
    );
  }
}

export class ProviderRateLimitError extends AgenticQaError {
  public constructor() {
    super(
      'PROVIDER_RATE_LIMITED',
      'The reasoning provider rate limit was reached. Try again later.',
    );
  }
}

export class ProviderTimeoutError extends AgenticQaError {
  public constructor(timeoutMs: number) {
    super('PROVIDER_TIMEOUT', `The reasoning provider timed out after ${String(timeoutMs)} ms.`);
  }
}

export class ProviderBadResponseError extends AgenticQaError {
  public constructor(message = 'The reasoning provider returned an unexpected response.') {
    super('PROVIDER_BAD_RESPONSE', message);
  }
}

export class PlanSchemaInvalidError extends AgenticQaError {
  public constructor(errors: readonly string[]) {
    super(
      'PLAN_SCHEMA_INVALID',
      `The reasoning provider returned an invalid plan after one repair attempt: ${errors.join('; ')}`,
    );
  }
}

export class PlanGroundingInvalidError extends AgenticQaError {
  public constructor(errors: readonly string[]) {
    super(
      'PLAN_GROUNDING_INVALID',
      `The proposed plan contains invalid graph references: ${errors.join('; ')}`,
    );
  }
}

export class ExecutionSourceError extends AgenticQaError {
  public constructor(message: string) {
    super('EXECUTION_SOURCE_INVALID', message);
  }
}

export class ExecutionIntegrityError extends AgenticQaError {
  public constructor(message: string) {
    super('EXECUTION_INTEGRITY_INVALID', message);
  }
}

export class ExecutionPlanError extends AgenticQaError {
  public constructor(message: string) {
    super('EXECUTION_PLAN_INVALID', message);
  }
}

export class VerificationSourceError extends AgenticQaError {
  public constructor(message: string) {
    super('VERIFICATION_SOURCE_INVALID', message);
  }
}

export class VerificationIntegrityError extends AgenticQaError {
  public constructor(message: string) {
    super('VERIFICATION_INTEGRITY_INVALID', message);
  }
}

export class RegressionSourceError extends AgenticQaError {
  public constructor(message: string) {
    super('REGRESSION_SOURCE_INVALID', message);
  }
}

export class RegressionIntegrityError extends AgenticQaError {
  public constructor(message: string) {
    super('REGRESSION_INTEGRITY_INVALID', message);
  }
}

export class RegressionGenerationError extends AgenticQaError {
  public constructor(message: string, options?: ErrorOptions) {
    super('REGRESSION_GENERATION_FAILED', message, options);
  }
}

export class ExportSourceError extends AgenticQaError {
  public constructor(message: string) {
    super('EXPORT_SOURCE_INVALID', message);
  }
}

export class ExportTargetSafetyError extends AgenticQaError {
  public constructor(message: string) {
    super('EXPORT_TARGET_UNSAFE', message);
  }
}

export class ExportConflictError extends AgenticQaError {
  public constructor(message: string) {
    super('EXPORT_CONFLICT', message);
  }
}

export class ExportWriteError extends AgenticQaError {
  public constructor(message: string, options?: ErrorOptions) {
    super('EXPORT_WRITE_FAILED', message, options);
  }
}

export class ExportValidationError extends AgenticQaError {
  public constructor(message: string, options?: ErrorOptions) {
    super('EXPORT_VALIDATION_FAILED', message, options);
  }
}

export class PipelineError extends AgenticQaError {
  public constructor(message: string, options?: ErrorOptions) {
    super('PIPELINE_FAILED', message, options);
  }
}

export class ReportSourceError extends AgenticQaError {
  public constructor(message: string) {
    super('REPORT_SOURCE_INVALID', message);
  }
}
