import type { PipelineReportSourceReader, PipelineHtmlRenderer } from './pipeline-ports.js';

export interface RenderPipelineReportOutcome {
  readonly pipelineId: string;
  readonly status: string;
  readonly reportFile: string;
}

interface PipelineReportWriter {
  saveRenderedReport(runDirectory: string, html: string): Promise<string>;
}

export class RenderPipelineReport {
  public constructor(
    private readonly reader: PipelineReportSourceReader,
    private readonly renderer: PipelineHtmlRenderer,
    private readonly writer: PipelineReportWriter,
  ) {}

  public async execute(path: string): Promise<RenderPipelineReportOutcome> {
    const loaded = await this.reader.load(path);
    const reportFile = await this.writer.saveRenderedReport(
      loaded.runDirectory,
      this.renderer.render(loaded.data),
    );
    return {
      pipelineId: loaded.data.pipeline.pipelineId,
      status: loaded.data.pipeline.status,
      reportFile,
    };
  }
}
