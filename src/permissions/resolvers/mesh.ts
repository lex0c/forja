// Mesh tool resolvers. mesh_send / mesh_reply have no resolver-relevant
// capabilities to gate — no fs paths, no shell command, no network host. Their
// effect (a message to a local peer over a socket the manager already holds) is
// governed by the permission CATEGORY (mesh.egress / mesh.reply), not the
// resolver. Declaring an empty, HIGH-confidence set keeps them off the
// conservative fallback (registry.ts): that fallback would force a confirm on
// every call — harmless for mesh_send (egress, always confirms anyway) but it
// would break mesh_reply's posture-respecting auto-approval under autonomous
// (MESH.md §5.3), since a conservative/low-confidence resolver result trips
// `resolverForcesConfirm`. mesh_peers is `misc` and skips the resolver entirely.

import { type Resolver, registerResolver } from './registry.ts';

const noResolverCapabilities: Resolver = () => ({
  kind: 'ok',
  capabilities: [],
  confidence: 'high',
});

registerResolver('mesh_send', noResolverCapabilities);
registerResolver('mesh_reply', noResolverCapabilities);
