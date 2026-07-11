// A minimal REAL mesh peer for the smoke — not a full Forja, just enough of the
// wire to prove that mesh_send from the COMPILED binary reaches a live peer over
// the Unix socket. It reuses the actual wire code (src/mesh/*), so a protocol
// drift breaks it exactly as it would break a real peer.
//
// It publishes a descriptor into the runtime dir (so the binary's mesh_peers
// discovers it via the FS registry), listens on the socket, speaks the
// hello/message handshake, and APPENDS every received message to a trace file so
// the smoke can assert delivery. A serving Forja needs an interactive TTY REPL
// (/relay on) which a shell can't drive — this fixture stands in for the peer's
// SERVER side so the smoke can exercise the binary's CLIENT side headlessly.
//
// Env: MESH_FIXTURE_DIR (the mesh runtime dir, i.e. <base>/forja/mesh),
//      MESH_FIXTURE_TRACE (append log), MESH_FIXTURE_ALIAS (default "testpeer").
// Run: `bun evals/mesh/fixtures/peer.ts` (from the repo). Stop: SIGTERM/SIGINT.

import { appendFileSync } from 'node:fs';
import {
  encodeMeshMessage,
  makeHello,
  makeMessage,
  parseMeshLine,
} from '../../../src/mesh/protocol.ts';
import { ensureMeshDirs, publishDescriptor, socketPath } from '../../../src/mesh/registry.ts';
import { listenMesh } from '../../../src/mesh/transport.ts';

const dir = process.env.MESH_FIXTURE_DIR;
const trace = process.env.MESH_FIXTURE_TRACE;
const alias = process.env.MESH_FIXTURE_ALIAS ?? 'testpeer';
if (dir === undefined || trace === undefined) {
  console.error('peer fixture: MESH_FIXTURE_DIR and MESH_FIXTURE_TRACE are required');
  process.exit(1);
}

const log = (line: string): void => appendFileSync(trace, `${line}\n`);

ensureMeshDirs(dir);
const server = listenMesh(socketPath(dir, alias), (t) => {
  let peerAlias: string | null = null;
  t.onLine((line) => {
    const res = parseMeshLine(line);
    if (!res.ok) return;
    const msg = res.msg;
    if (msg.type === 'hello') {
      peerAlias = msg.alias;
      t.write(encodeMeshMessage(makeHello(alias)));
    } else if (msg.type === 'message') {
      // The delivery proof the smoke greps for.
      log(`received from ${peerAlias ?? '?'}: ${msg.text}`);
      // Reply with a message the other way (a real peer would) — harmless if the
      // one-shot client has already exited; proves the reverse path is wired too.
      t.write(encodeMeshMessage(makeMessage(`ack: ${msg.text}`)));
      t.close();
    }
  });
});

publishDescriptor(dir, {
  alias,
  repoRoot: '/fixture-peer',
  branch: 'main',
  pid: process.pid,
  socket: socketPath(dir, alias),
  status: 'idle',
  startedAt: Date.now(),
});
log(`peer ${alias}: ready`);

const shutdown = (): void => {
  server.stop();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
// Keep the event loop alive until signalled.
setInterval(() => {}, 1 << 30);
