import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { URL } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const projectRoot = resolve(import.meta.dirname, '..');
const npmCli = process.env.npm_execpath;
if (npmCli === undefined || npmCli === '') {
  throw new Error('release package smoke must be launched through npm run.');
}
const npxCli = join(dirname(npmCli), 'npx-cli.js');

async function execute(executable, args, options = {}) {
  return execFileAsync(executable, args, {
    shell: false,
    timeout: 180_000,
    maxBuffer: 2_000_000,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    ...options,
  });
}

function fixtureServer() {
  return createServer((request, response) => {
    const path = new URL(request.url ?? '/', 'http://fixture.invalid').pathname;
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html><html><head><title>Packaged CLI fixture</title></head><body>
      <h1>Packaged CLI fixture</h1>
      ${path === '/' ? '<a href="/about">About</a><button type="button" aria-expanded="false">Menu</button>' : '<a href="/">Home</a>'}
    </body></html>`);
  });
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'agentic-qa-release-smoke-'));
let server;
try {
  const packDirectory = join(temporaryRoot, 'pack');
  const installDirectory = join(temporaryRoot, 'install');
  const artifactsDirectory = join(temporaryRoot, 'artifacts');
  await Promise.all([mkdir(packDirectory), mkdir(installDirectory), mkdir(artifactsDirectory)]);

  const packed = await execute(
    process.execPath,
    [npmCli, 'pack', '--json', '--pack-destination', packDirectory],
    { cwd: projectRoot },
  );
  const packJson = JSON.parse(packed.stdout);
  const packResult = Array.isArray(packJson) ? packJson[0] : Object.values(packJson)[0];
  const filename = packResult?.filename;
  if (typeof filename !== 'string') throw new Error('npm pack did not report a tarball filename.');
  const tarball = join(packDirectory, filename);
  const bytes = await readFile(tarball);
  const tarballDigest = createHash('sha256').update(bytes).digest('hex');

  await writeFile(
    join(installDirectory, 'package.json'),
    `${JSON.stringify({ name: 'agentic-qa-clean-install-smoke', private: true })}\n`,
    'utf8',
  );
  await execute(process.execPath, [npmCli, 'install', '--omit=dev', '--ignore-scripts', tarball], {
    cwd: installDirectory,
  });

  const version = await execute(
    process.execPath,
    [npxCli, '--no-install', 'agentic-qa', '--version'],
    {
      cwd: installDirectory,
    },
  );
  if (version.stdout.trim() !== '1.0.0') {
    throw new Error(`Installed CLI reported unexpected version: ${version.stdout.trim()}`);
  }
  const help = await execute(process.execPath, [npxCli, '--no-install', 'agentic-qa', '--help'], {
    cwd: installDirectory,
  });
  if (!help.stdout.includes('inspect') || !help.stdout.includes('pipeline')) {
    throw new Error('Installed CLI help is incomplete.');
  }

  server = fixtureServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Fixture did not bind.');
  const baseUrl = `http://127.0.0.1:${String(address.port)}`;

  const inspectArtifacts = join(artifactsDirectory, 'inspect');
  const exploreArtifacts = join(artifactsDirectory, 'explore');
  const interactiveArtifacts = join(artifactsDirectory, 'interactive');
  await execute(
    process.execPath,
    [
      npxCli,
      '--no-install',
      'agentic-qa',
      'inspect',
      baseUrl,
      '--artifacts-dir',
      inspectArtifacts,
      '--timeout',
      '10000',
    ],
    { cwd: installDirectory },
  );
  await execute(
    process.execPath,
    [
      npxCli,
      '--no-install',
      'agentic-qa',
      'explore',
      baseUrl,
      '--artifacts-dir',
      exploreArtifacts,
      '--max-pages',
      '2',
      '--max-depth',
      '1',
      '--timeout',
      '10000',
    ],
    { cwd: installDirectory },
  );
  await execute(
    process.execPath,
    [
      npxCli,
      '--no-install',
      'agentic-qa',
      'explore',
      baseUrl,
      '--interactive',
      '--artifacts-dir',
      interactiveArtifacts,
      '--max-pages',
      '2',
      '--max-depth',
      '1',
      '--max-states',
      '3',
      '--max-actions-per-state',
      '1',
      '--max-state-depth',
      '1',
      '--timeout',
      '10000',
    ],
    { cwd: installDirectory },
  );

  const inspectRuns = await readdir(inspectArtifacts);
  const exploreRuns = await readdir(exploreArtifacts);
  const interactiveRuns = await readdir(interactiveArtifacts);
  if (inspectRuns.length !== 1 || exploreRuns.length !== 1 || interactiveRuns.length !== 1) {
    throw new Error(
      'Installed CLI did not create exactly one inspect, explore, and interactive run.',
    );
  }
  const result = JSON.parse(
    await readFile(join(inspectArtifacts, inspectRuns[0], 'result.json'), 'utf8'),
  );
  const exploration = JSON.parse(
    await readFile(join(exploreArtifacts, exploreRuns[0], 'exploration.json'), 'utf8'),
  );
  const trace = await stat(join(exploreArtifacts, exploreRuns[0], 'trace.zip'));
  const interactive = JSON.parse(
    await readFile(join(interactiveArtifacts, interactiveRuns[0], 'exploration.json'), 'utf8'),
  );
  const stateGraph = await stat(join(interactiveArtifacts, interactiveRuns[0], 'state-graph.json'));
  if (result.page?.title !== 'Packaged CLI fixture')
    throw new Error('Inspect smoke result is wrong.');
  if (exploration.summary?.pagesVisited !== 2 || trace.size <= 100) {
    throw new Error('Explore smoke result or trace is incomplete.');
  }
  if (
    interactive.interactive?.enabled !== true ||
    interactive.interactive?.statesDiscovered < 2 ||
    stateGraph.size <= 100
  ) {
    throw new Error('Interactive explore smoke result or state graph is incomplete.');
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status: 'PASS',
        platform: process.platform,
        node: process.version,
        package: {
          filename,
          bytes: bytes.length,
          sha256: tarballDigest,
          files: packResult?.entryCount ?? null,
          unpackedSize: packResult?.unpackedSize ?? null,
        },
        cli: {
          version: version.stdout.trim(),
          help: true,
          inspect: true,
          explore: true,
          interactiveExplore: true,
        },
      },
      null,
      2,
    )}\n`,
  );
} finally {
  if (server !== undefined) {
    server.close();
    await once(server, 'close').catch(() => undefined);
  }
  await rm(temporaryRoot, { recursive: true, force: true });
}
