import { once } from 'node:events';
import { createServer } from 'node:http';

export interface FakeLlmRequest {
  readonly index: number;
  readonly path: string;
  readonly authorization: string | null;
  readonly body: unknown;
  readonly rawBody: string;
}

export interface FakeLlmReply {
  readonly status?: number;
  readonly content?: unknown;
  readonly usage?: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  } | null;
  readonly delayMs?: number;
  readonly rawHttpBody?: string;
}

export interface FakeLlmServer {
  readonly baseUrl: string;
  readonly requests: readonly FakeLlmRequest[];
  close(): Promise<void>;
}

export async function startFakeLlmServer(
  handler: (request: FakeLlmRequest) => FakeLlmReply,
): Promise<FakeLlmServer> {
  const requests: FakeLlmRequest[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try {
        body = JSON.parse(rawBody);
      } catch {
        body = rawBody;
      }
      const captured: FakeLlmRequest = {
        index: requests.length,
        path: request.url ?? '/',
        authorization: request.headers.authorization ?? null,
        body,
        rawBody,
      };
      requests.push(captured);
      const reply = handler(captured);
      const send = (): void => {
        if (response.destroyed) return;
        response.writeHead(reply.status ?? 200, { 'content-type': 'application/json' });
        if (reply.rawHttpBody !== undefined) {
          response.end(reply.rawHttpBody);
          return;
        }
        response.end(
          JSON.stringify({
            id: `fake-${String(captured.index + 1)}`,
            choices: [{ message: { role: 'assistant', content: reply.content ?? '{}' } }],
            ...(reply.usage === undefined || reply.usage === null ? {} : { usage: reply.usage }),
          }),
        );
      };
      if (reply.delayMs === undefined) send();
      else setTimeout(send, reply.delayMs);
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('Fake LLM server did not bind');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}/v1`,
    requests,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}
