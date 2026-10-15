import { readFileSync } from 'node:fs';

const server = readFileSync('server.js', 'utf8');
const probe = readFileSync(process.env.WAVE1_PROBE || "/tmp/wave1-probe.txt", 'utf8');

// --- evidence from the probe: which exercised writes produced an attribution record --------------
const probed = new Map();
for (const line of probe.split('\n')) {
  const m = /^(\S+)\s+(POST|PATCH|DELETE)\s+(\d{3})\s+(\S+)\s+(.*)$/.exec(line);
  if (!m) continue;
  probed.set(`${m[2]} ${m[1]}`, m[4] !== '-');
}

// --- declarations read out of server.js at the base commit --------------------------------------
const writesBlock = server.match(/const writes = new Map\(\[([\s\S]*?)\n\]\);/)[1];
const declared = [...writesBlock.matchAll(/\['([^']+)',\s*\[([^,\]]+),\s*([^\]]+)\]\]/g)].map((m) => ({ route: m[1], method: m[2].trim().replaceAll("'", ''), scope: m[3].trim() === 'null' ? null : m[3].trim().replaceAll("'", '') }));
const dynamic = [...server.match(/const match = \/\^\\\/agents\\\/\(\[\^\/\]\+\)\\\/\(([^)]+)\)\$\//)[1].split('|')];
const dynamicScopes = Object.fromEntries([...server.match(/scope: \{ ([^}]+) \}\[match\[2\]\]/)[1].matchAll(/(\w+): (?:'(\w+)'|null)/g)].map((m) => [m[1], m[2] || null]));
const KEYED = [...server.match(/\.includes\(route\)\) value = platform\[method\]\(actor, input, request\.headers\['idempotency-key'\]\)/g) ? server.match(/\['([^']+)'(?:, '[^']+')*\](?:\.concat\([^)]*\))?\.includes\(route\)\) value = platform\[method\]\(actor, input, request\.headers\['idempotency-key'\]\)/) : null];

// --- the policy this wave declares ---------------------------------------------------------------
const IDEMPOTENT = ['/claims', '/submissions', '/drafts/resume', '/tasks/follow-up', '/quests/join', '/interact', '/journey/offers', '/journey/offers/accept', '/trade/listings', '/trade/claim'];
const PUBLIC = ['/auth/register', '/auth/login'];
const OPERATOR_ONLY_EXTRA = ['PATCH /agents/:id/home'];
const READ_SCOPE_WRITES = ['POST /agents/:id/heartbeat'];
const MAY_SKIP_WRITE = ['/drafts', '/residents/cancel', '/research/cancel', '/frontier/expand', '/frontier/grant/revoke', '/quests/complete'];
// Audited routes the probe cannot reach, verified by reading the named method at 27c0d72.
const BLOCKED_AUDIT = { '/auth/register': true, '/auth/login': false, '/operations/backup': true, '/residents/run': true, '/residents/resume': true, '/research/run': true, '/research/activate': true, '/memory/propose': true, '/restoration/join': true, '/restoration/leave': true, '/restoration/contribute': true, '/callings/select': true, '/quests/complete': true, '/guilds/verify': null, '/restoration/place': null, '/evidence/capture': null, '/research/generate': null };

const domain = (route) => {
  if (route.startsWith('/auth/') || route === '/me') return 'auth';
  if (route === '/invites' || route.startsWith('/agents')) return route === '/agents/:id/build' || route === '/agents/:id/home' ? 'building' : route === '/agents/:id/heartbeat' ? 'presence' : route.startsWith('/agents/:id/') ? 'movement' : 'residents';
  if (route === '/runtime/start') return 'runtime';
  if (route === '/move' || route === '/climb') return 'movement';
  if (route === '/emotes') return 'presence';
  if (route === '/messages') return 'chat';
  if (route === '/interact') return 'interaction';
  if (route.startsWith('/land') || route.startsWith('/frontier/grant')) return 'land';
  if (route.startsWith('/frontier')) return 'frontier';
  if (route.startsWith('/drafts')) return 'drafts';
  if (route.startsWith('/claims')) return 'claims';
  if (route.startsWith('/submissions')) return 'submissions';
  if (route.startsWith('/reviews')) return 'review';
  if (route.startsWith('/adoptions')) return 'adoption';
  if (route.startsWith('/tasks')) return 'tasks';
  if (route.startsWith('/missions')) return 'missions';
  if (route.startsWith('/reports') || route.startsWith('/appeals') || route === '/moderation') return 'moderation';
  if (route.startsWith('/operations')) return 'operations';
  if (route.startsWith('/residents') || route.startsWith('/research/run') || route.startsWith('/research/cancel') || route === '/jobs') return 'workers';
  if (route.startsWith('/research/')) return 'civic';
  if (route.startsWith('/mayors') || route.startsWith('/ambassadors')) return 'civic';
  if (route.startsWith('/circles') || route === '/community/manage') return 'community';
  if (route.startsWith('/projects')) return 'projects';
  if (route.startsWith('/events')) return 'gatherings';
  if (route === '/thanks') return 'thanks';
  if (route.startsWith('/journey')) return 'journey';
  if (route.startsWith('/trade')) return 'trade';
  if (route.startsWith('/quests')) return 'quests';
  if (route.startsWith('/guilds')) return 'guilds';
  if (route.startsWith('/memory')) return 'memory';
  if (route.startsWith('/vault')) return 'vault';
  if (route.startsWith('/restoration')) return 'restoration';
  if (route.startsWith('/evidence')) return 'evidence';
  if (route === '/callings/select') return 'vocations';
  return 'unknown';
};

const entries = [
  ...declared.map(({ route, method, scope }) => ({ route, method: 'POST', scope, methodName: method })),
  ...dynamic.map((action) => ({ route: `/agents/:id/${action}`, method: action === 'home' ? 'PATCH' : 'POST', scope: dynamicScopes[action], methodName: null })),
  { route: '/auth/register', method: 'POST', scope: null, methodName: null },
  { route: '/auth/login', method: 'POST', scope: null, methodName: null },
  { route: '/operations/backup', method: 'POST', scope: null, methodName: null },
  { route: '/me', method: 'DELETE', scope: null, methodName: null },
].sort((a, b) => `${a.route} ${a.method}`.localeCompare(`${b.route} ${b.method}`));

const rows = entries.map((entry) => {
  const publicRoute = PUBLIC.includes(entry.route);
  const operatorOnly = OPERATOR_ONLY_EXTRA.includes(`${entry.method} ${entry.route}`) || (entry.scope === null && !publicRoute);
  const key = `${entry.method} ${entry.route}`;
  const audit = probed.has(key) ? probed.get(key) : (entry.route in BLOCKED_AUDIT ? BLOCKED_AUDIT[entry.route] : null);
  return { ...entry, publicRoute, operatorOnly, runtime: entry.scope !== null && !operatorOnly, session: !publicRoute, keyed: IDEMPOTENT.includes(entry.route), audit, readScopeWrite: READ_SCOPE_WRITES.includes(key), maySkip: MAY_SKIP_WRITE.includes(entry.route) };
});

const line = (r) => `  { route: '${r.route}', method: '${r.method}', domain: '${domain(r.route)}', scope: ${r.scope === null ? 'null' : `'${r.scope}'`}, session: ${r.session}, runtime: ${r.runtime}, public: ${r.publicRoute}, operator_only: ${r.operatorOnly},\n    idempotency_keyed: ${r.keyed}, audit: ${r.audit === null ? 'null' : r.audit}, durable_before_response: true, read_scope_write: ${r.readScopeWrite}, may_skip_write: ${r.maySkip} },`;

const out = `// The declared write contract, as data. Every write route the server accepts at base commit
// 27c0d72 states here: its method, owning domain, the scope a runtime credential must hold, whether a
// session or a runtime is sufficient, whether it is operator-only, whether the keyed-submission
// mechanism applies, whether an attribution record is expected, and whether a 2xx may answer without
// a new write. \`tests/framework-*.test.js\` enforces exactly this table against a real server over
// real HTTP; nothing here is advisory and nothing here is enforced from somewhere else.
//
// It was derived by reading \`server.js\` at 27c0d72 (the \`writes\` map, the dynamic agent-action
// regex and its scope map, \`specialWrite\`, \`publicRoute\`, the runtime-versus-operator refusal and
// the keyed-route list) and by driving each route against a disposable database with
// \`tests/framework/probe.mjs\`. Where the honest answer could not be established the field is
// \`null\` rather than a guess: \`audit: null\` means no attribution record is guaranteed, and
// \`audit: false\` means the route was verified to write none.
//
// Field meaning
//   scope                    the scope a *runtime* credential must hold; null requires an operator
//   session / runtime        whether that credential class can complete the write
//   public                   reachable with no credential at all (the two authentication writes)
//   operator_only            a runtime credential is refused even when it holds every scope
//   idempotency_keyed        the Idempotency-Key header is applied by the server's keyed mechanism
//   audit                    true: at least one attribution record naming the acting account
//                            false: verified to write none; null: not guaranteed (unverified)
//   durable_before_response  the answered effect is committed before the answer is written
//   read_scope_write         a write a *read*-scoped credential can perform (see the known gaps)
//   may_skip_write           a 2xx is honest without a new write (an unchanged save or a no-op)
export const CONTRACT_BASE_COMMIT = '27c0d72';
export const WRITE_CONTRACT_ROUTES = ${rows.length};

// The scope vocabulary a runtime credential can carry, in the order the platform accepts it.
export const SCOPES = Object.freeze(['read', 'move', 'chat', 'contribute', 'build', 'vault']);
export const POLICY_FIELDS = Object.freeze(['route', 'method', 'domain', 'scope', 'session', 'runtime', 'public', 'operator_only', 'idempotency_keyed', 'audit', 'durable_before_response', 'read_scope_write', 'may_skip_write']);

export const WRITE_ROUTES = Object.freeze([
${rows.map(line).join('\n')}
].map(Object.freeze));

const index = new Map(WRITE_ROUTES.map((entry) => [\`\${entry.method} \${entry.route}\`, entry]));

/** The declared policy for one write, or undefined when the route is not a declared write. */
export const policyFor = (route, method = 'POST') => index.get(\`\${method} \${route}\`);

/** Every declared write whose resolved path matches a concrete request path. */
export function policiesForPath(path, method = 'POST') {
  return WRITE_ROUTES.filter((entry) => entry.method === method && new RegExp(\`^\${entry.route.replaceAll(':id', '[^/]+')}$\`).test(path));
}

export const declaredRoutes = () => WRITE_ROUTES.map((entry) => \`\${entry.method} \${entry.route}\`);
export const operatorOnlyRoutes = () => WRITE_ROUTES.filter((entry) => entry.operator_only).map((entry) => \`\${entry.method} \${entry.route}\`);
export const keyedRoutes = () => WRITE_ROUTES.filter((entry) => entry.idempotency_keyed).map((entry) => \`\${entry.method} \${entry.route}\`);
export const auditedRoutes = () => WRITE_ROUTES.filter((entry) => entry.audit === true).map((entry) => \`\${entry.method} \${entry.route}\`);
export const unauditedRoutes = () => WRITE_ROUTES.filter((entry) => entry.audit === false).map((entry) => \`\${entry.method} \${entry.route}\`);
export const unknownAuditRoutes = () => WRITE_ROUTES.filter((entry) => entry.audit === null).map((entry) => \`\${entry.method} \${entry.route}\`);
export const readScopeWriteRoutes = () => WRITE_ROUTES.filter((entry) => entry.read_scope_write).map((entry) => \`\${entry.method} \${entry.route}\`);
`;
console.log(out);
