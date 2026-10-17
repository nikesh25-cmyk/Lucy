// The declared write contract, as data. Every write route the server accepts at base commit
// 27c0d72 states here: its method, owning domain, the scope a runtime credential must hold, whether a
// session or a runtime is sufficient, whether it is operator-only, whether the keyed-submission
// mechanism applies, whether an attribution record is expected, and whether a 2xx may answer without
// a new write. `tests/framework-*.test.js` enforces exactly this table against a real server over
// real HTTP; nothing here is advisory and nothing here is enforced from somewhere else.
//
// It was derived by reading `server.js` at 27c0d72 (the `writes` map, the dynamic agent-action
// regex and its scope map, `specialWrite`, `publicRoute`, the runtime-versus-operator refusal and
// the keyed-route list) and by driving each route against a disposable database with
// `tests/framework/probe.mjs`. Where the honest answer could not be established the field is
// `null` rather than a guess: `audit: null` means no attribution record is guaranteed, and
// `audit: false` means the route was verified to write none.
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
export const WRITE_CONTRACT_ROUTES = 106;

// The scope vocabulary a runtime credential can carry, in the order the platform accepts it.
export const SCOPES = Object.freeze(['read', 'move', 'chat', 'contribute', 'build', 'vault']);
export const POLICY_FIELDS = Object.freeze(['route', 'method', 'domain', 'scope', 'session', 'runtime', 'public', 'operator_only', 'idempotency_keyed', 'audit', 'durable_before_response', 'read_scope_write', 'may_skip_write']);

export const WRITE_ROUTES = Object.freeze([
  // Integration additions. /residents/act has no single route scope: its inner
  // lifecycle checks the stored credential against the selected action's scope.
  { route: '/residents/act', method: 'POST', domain: 'residents', scope: null, dynamic_scope: true, session: false, runtime: true, public: false, operator_only: false,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/activity/tasks/check', method: 'POST', domain: 'activity', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/activity/author', method: 'POST', domain: 'activity', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/karma/settle', method: 'POST', domain: 'karma', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/shop/purchase', method: 'POST', domain: 'shop', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/adoptions', method: 'POST', domain: 'adoption', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/agents', method: 'POST', domain: 'residents', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/agents/:id/build', method: 'POST', domain: 'building', scope: 'build', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/agents/:id/climb', method: 'POST', domain: 'movement', scope: 'move', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/agents/:id/heartbeat', method: 'POST', domain: 'presence', scope: 'read', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: true, may_skip_write: false },
  { route: '/agents/:id/home', method: 'PATCH', domain: 'building', scope: 'build', session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/agents/:id/look', method: 'POST', domain: 'movement', scope: 'move', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/agents/:id/posture', method: 'POST', domain: 'movement', scope: 'move', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/agents/:id/travel', method: 'POST', domain: 'movement', scope: 'move', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/agents/control', method: 'POST', domain: 'residents', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/ambassadors/control', method: 'POST', domain: 'civic', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/ambassadors/talk', method: 'POST', domain: 'civic', scope: 'chat', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/appeals', method: 'POST', domain: 'moderation', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/appeals/decide', method: 'POST', domain: 'moderation', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/auth/login', method: 'POST', domain: 'auth', scope: null, session: false, runtime: false, public: true, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/auth/logout', method: 'POST', domain: 'auth', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/auth/register', method: 'POST', domain: 'auth', scope: null, session: false, runtime: false, public: true, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/callings/select', method: 'POST', domain: 'vocations', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/circles', method: 'POST', domain: 'community', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/circles/membership', method: 'POST', domain: 'community', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/claims', method: 'POST', domain: 'claims', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/claims/release', method: 'POST', domain: 'claims', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/climb', method: 'POST', domain: 'movement', scope: 'move', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/community/manage', method: 'POST', domain: 'community', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/drafts', method: 'POST', domain: 'drafts', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/drafts/archive', method: 'POST', domain: 'drafts', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/drafts/resume', method: 'POST', domain: 'drafts', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/emotes', method: 'POST', domain: 'presence', scope: 'move', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/events', method: 'POST', domain: 'gatherings', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/events/rsvp', method: 'POST', domain: 'gatherings', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/evidence/capture', method: 'POST', domain: 'evidence', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: null, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/evidence/withdraw', method: 'POST', domain: 'evidence', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/frontier/build', method: 'POST', domain: 'frontier', scope: 'build', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/frontier/expand', method: 'POST', domain: 'frontier', scope: 'build', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/frontier/grant', method: 'POST', domain: 'land', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/frontier/grant/revoke', method: 'POST', domain: 'land', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/guilds/contributions', method: 'POST', domain: 'guilds', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/guilds/manage', method: 'POST', domain: 'guilds', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/guilds/participation', method: 'POST', domain: 'guilds', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/guilds/projects', method: 'POST', domain: 'guilds', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/guilds/verify', method: 'POST', domain: 'guilds', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: null, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/interact', method: 'POST', domain: 'interaction', scope: 'move', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/invites', method: 'POST', domain: 'residents', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/jobs', method: 'POST', domain: 'workers', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/journey/craft', method: 'POST', domain: 'journey', scope: 'build', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/journey/garden', method: 'POST', domain: 'journey', scope: 'build', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/journey/journal', method: 'POST', domain: 'journey', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/journey/offers', method: 'POST', domain: 'journey', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/journey/offers/accept', method: 'POST', domain: 'journey', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/journey/offers/cancel', method: 'POST', domain: 'journey', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/journey/offers/decline', method: 'POST', domain: 'journey', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/journey/profile', method: 'POST', domain: 'journey', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/land/assign', method: 'POST', domain: 'land', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/land/release', method: 'POST', domain: 'land', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/mayors/control', method: 'POST', domain: 'civic', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/mayors/talk', method: 'POST', domain: 'civic', scope: 'chat', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/me', method: 'DELETE', domain: 'auth', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/memory/manage', method: 'POST', domain: 'memory', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/memory/propose', method: 'POST', domain: 'memory', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/messages', method: 'POST', domain: 'chat', scope: 'chat', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/missions', method: 'POST', domain: 'missions', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/missions/status', method: 'POST', domain: 'missions', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/moderation', method: 'POST', domain: 'moderation', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/move', method: 'POST', domain: 'movement', scope: 'move', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/operations/accounts', method: 'POST', domain: 'operations', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/operations/backup', method: 'POST', domain: 'operations', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/operations/pause', method: 'POST', domain: 'operations', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/operations/registration', method: 'POST', domain: 'operations', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/projects', method: 'POST', domain: 'projects', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/projects/milestones', method: 'POST', domain: 'projects', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/projects/pledges', method: 'POST', domain: 'projects', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/quests/author', method: 'POST', domain: 'quests', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/quests/complete', method: 'POST', domain: 'quests', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/quests/join', method: 'POST', domain: 'quests', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/quests/leave', method: 'POST', domain: 'quests', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/quests/manage', method: 'POST', domain: 'quests', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/reports', method: 'POST', domain: 'moderation', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/research/activate', method: 'POST', domain: 'civic', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/research/cancel', method: 'POST', domain: 'workers', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/research/generate', method: 'POST', domain: 'civic', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: null, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/research/run', method: 'POST', domain: 'workers', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/residents/cancel', method: 'POST', domain: 'workers', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: false, durable_before_response: true, read_scope_write: false, may_skip_write: true },
  { route: '/residents/resume', method: 'POST', domain: 'workers', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/residents/run', method: 'POST', domain: 'workers', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/restoration/contribute', method: 'POST', domain: 'restoration', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/restoration/join', method: 'POST', domain: 'restoration', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/restoration/leave', method: 'POST', domain: 'restoration', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/restoration/open', method: 'POST', domain: 'restoration', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/restoration/place', method: 'POST', domain: 'restoration', scope: 'build', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: null, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/reviews', method: 'POST', domain: 'review', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/runtime/start', method: 'POST', domain: 'runtime', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/submissions', method: 'POST', domain: 'submissions', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/tasks', method: 'POST', domain: 'tasks', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/tasks/follow-up', method: 'POST', domain: 'tasks', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/thanks', method: 'POST', domain: 'thanks', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/trade/cancel', method: 'POST', domain: 'trade', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/trade/claim', method: 'POST', domain: 'trade', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/trade/listings', method: 'POST', domain: 'trade', scope: 'contribute', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: true, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/vault/enroll', method: 'POST', domain: 'vault', scope: 'vault', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/vault/manage', method: 'POST', domain: 'vault', scope: null, session: true, runtime: false, public: false, operator_only: true,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
  { route: '/vault/write', method: 'POST', domain: 'vault', scope: 'vault', session: true, runtime: true, public: false, operator_only: false,
    idempotency_keyed: false, audit: true, durable_before_response: true, read_scope_write: false, may_skip_write: false },
].map(Object.freeze));

const index = new Map(WRITE_ROUTES.map((entry) => [`${entry.method} ${entry.route}`, entry]));

/** The declared policy for one write, or undefined when the route is not a declared write. */
export const policyFor = (route, method = 'POST') => index.get(`${method} ${route}`);

/** Every declared write whose resolved path matches a concrete request path. */
export function policiesForPath(path, method = 'POST') {
  return WRITE_ROUTES.filter((entry) => entry.method === method && new RegExp(`^${entry.route.replaceAll(':id', '[^/]+')}$`).test(path));
}

export const declaredRoutes = () => WRITE_ROUTES.map((entry) => `${entry.method} ${entry.route}`);
export const operatorOnlyRoutes = () => WRITE_ROUTES.filter((entry) => entry.operator_only).map((entry) => `${entry.method} ${entry.route}`);
export const keyedRoutes = () => WRITE_ROUTES.filter((entry) => entry.idempotency_keyed).map((entry) => `${entry.method} ${entry.route}`);
export const auditedRoutes = () => WRITE_ROUTES.filter((entry) => entry.audit === true).map((entry) => `${entry.method} ${entry.route}`);
export const unauditedRoutes = () => WRITE_ROUTES.filter((entry) => entry.audit === false).map((entry) => `${entry.method} ${entry.route}`);
export const unknownAuditRoutes = () => WRITE_ROUTES.filter((entry) => entry.audit === null).map((entry) => `${entry.method} ${entry.route}`);
export const readScopeWriteRoutes = () => WRITE_ROUTES.filter((entry) => entry.read_scope_write).map((entry) => `${entry.method} ${entry.route}`);
