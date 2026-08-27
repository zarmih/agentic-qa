import { once } from 'node:events';
import { createServer, type Server } from 'node:http';

export interface MiniAppServer {
  readonly baseUrl: string;
  close(): Promise<void>;
}

function page(title: string, body: string, script = ''): string {
  return `<!doctype html>
    <html>
      <head><meta charset="utf-8"><title>${title}</title></head>
      <body><h1>${title}</h1>${body}${script}</body>
    </html>`;
}

function rootPage(): string {
  return page(
    'Exploration fixture',
    `<h2>Navigation</h2>
      <a href="/products">Products</a>
      <a href="/products">Products duplicate</a>
      <a href="#top">Root fragment</a>
      <a href="/about">About</a>
      <a href="/redirect">Redirect to about</a>
      <a href="/error">Server error</a>
      <a href="/slow">Slow page</a>
      <a href="https://external.invalid/outside">External</a>
      <a href="mailto:qa@example.test">Email</a>
      <a href="/logout">Unsafe logout</a>
      <a href="/search?q=one">Search one</a>
      <a href="/search?q=two">Search two</a>
      <a href="/search?q=three">Search three</a>
      <form><input name="query"><button type="button">Do not click</button></form>
      <img src="http://127.0.0.1:1/failed-image.png" alt="expected failure">`,
    `<script>
      console.warn('fixture console warning');
      console.error('fixture console error');
      setTimeout(() => { throw new Error('fixture page error'); }, 0);
    </script>`,
  );
}

function respond(server: Server): void {
  server.on('request', (request, response) => {
    const url = new URL(request.url ?? '/', 'http://fixture.test');
    if (url.pathname === '/redirect') {
      response.writeHead(302, { location: '/about' });
      response.end();
      return;
    }
    if (url.pathname === '/slow') {
      setTimeout(() => {
        if (response.destroyed) return;
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        response.end(page('Slow page', '<a href="/about">About</a>'));
      }, 600);
      return;
    }

    let status = 200;
    let html: string;
    switch (url.pathname) {
      case '/':
        html = rootPage();
        break;
      case '/products':
        html = page(
          'Products',
          '<a href="/products/1">Product one</a><a href="/products/2">Product two</a><a href="/">Home</a>',
        );
        break;
      case '/products/1':
        html = page(
          'Product one',
          '<a href="/products">Products</a><a href="/products/2">Next</a>',
        );
        break;
      case '/products/2':
        html = page(
          'Product two',
          '<a href="/products">Products</a><a href="/products/1#details">Previous</a>',
        );
        break;
      case '/about':
        html = page('About', '<a href="/">Home</a><a href="/products">Products</a>');
        break;
      case '/error':
        status = 500;
        html = page('Server error', '<a href="/about">About</a>');
        break;
      case '/search':
        html = page(`Search ${url.searchParams.get('q') ?? ''}`, '<a href="/">Home</a>');
        break;
      default:
        status = 404;
        html = page('Not found', '<a href="/">Home</a>');
    }
    response.writeHead(status, { 'content-type': 'text/html; charset=utf-8' });
    response.end(html);
  });
}

export async function startMiniAppServer(): Promise<MiniAppServer> {
  const server = createServer();
  respond(server);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Mini app did not bind');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    async close() {
      server.close();
      await once(server, 'close');
    },
  };
}
