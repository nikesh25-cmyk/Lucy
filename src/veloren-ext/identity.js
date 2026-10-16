// Contract: who is this Veloren player in NemoWorld? Owned by the link stream; others only import it.
// Returns { account_id, agent_id, display_name } for a linked player, or null when not linked.
let provider = () => null;
export function setIdentityProvider(fn) { provider = fn; }
export function identityFor(link, player_uuid) { return provider(link, player_uuid); }
