import type { ScenarioExecutionBrowser, ExecutionArtifactReader } from './execution-ports.js';
import type { Clock, RunIdGenerator } from './ports.js';
import { RunQaPlan } from './run-qa-plan.js';
import type { VerificationScenarioRunner } from './verification-ports.js';

export class ConstrainedScenarioReproducer implements VerificationScenarioRunner {
  public constructor(
    private readonly reader: ExecutionArtifactReader,
    private readonly browser: ScenarioExecutionBrowser,
    private readonly runIds: RunIdGenerator,
    private readonly clock: Clock,
  ) {}

  public runScenario(
    request: Parameters<VerificationScenarioRunner['runScenario']>[0],
  ): ReturnType<VerificationScenarioRunner['runScenario']> {
    const executor = new RunQaPlan(
      this.reader,
      request.artifacts,
      this.browser,
      this.runIds,
      this.clock,
    );
    return executor.execute(request.planPath, {
      ...request.options,
      explorationPath: request.explorationPath,
      scenarioIds: [request.scenarioId],
      maxScenarios: 1,
    });
  }
}
