import type {
  QaReasoningProvider,
  ReasoningProviderRequest,
  ReasoningProviderResponse,
} from '../../src/application/planning-ports.js';

export class FakeReasoningProvider implements QaReasoningProvider {
  public readonly requests: ReasoningProviderRequest[] = [];

  public constructor(private readonly responses: readonly ReasoningProviderResponse[]) {}

  public generatePlan(request: ReasoningProviderRequest): Promise<ReasoningProviderResponse> {
    this.requests.push(request);
    const response = this.responses[this.requests.length - 1];
    if (response === undefined)
      return Promise.reject(new Error('No fake provider response remains.'));
    return Promise.resolve(response);
  }
}
