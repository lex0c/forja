// Mesh tool resolver. mesh_send has no resolver-relevant capabilities to gate —
// no fs paths, no shell command, no network host. Its effect (a message to a
// local peer over a socket) is governed by the permission CATEGORY (mesh.egress),
// not the resolver. Declaring an empty, HIGH-confidence set keeps it off the
// conservative fallback (registry.ts): that fallback would force a confirm on
// every call, which would break mesh_send's posture-respecting auto-approval
// under autonomous (MESH.md §5.3), since a conservative/low-confidence resolver
// result trips `resolverForcesConfirm`. mesh_peers is `misc` and skips the
// resolver entirely.

import { type Resolver, registerResolver } from './registry.ts';

const noResolverCapabilities: Resolver = () => ({
  kind: 'ok',
  capabilities: [],
  confidence: 'high',
});

registerResolver('mesh_send', noResolverCapabilities);
