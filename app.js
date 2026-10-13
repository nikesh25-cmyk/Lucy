import {createVoxelWorld} from './src/voxel-world.js';
import {controlIntent,createLookScheduler,reticleText,INTERACTION_DISTANCE,createViewBlocker,INTERACTION_KEY_LABEL,controlHint,targetHint,createPresenceTracker,displayCoords,moveFeedback,blockedCause,travelRoutes,routeHint} from './src/camera-controls.js';
import {createGameInput} from './src/game-input.js';
import {createMovementQueue} from './src/movement-queue.js';
import {createPortalJourney} from './src/world-navigation.js';
import {blockLayers,surfaceAt} from './src/elevation.js';
import {createHotbar,createPlacementPreview,mount} from './src/ui/build-interface.js';
import {createInventoryPanel} from './src/ui/inventory-panel.js';
import {createInteractionPrompt,confirmationMessage} from './src/ui/interaction-prompt.js';
import {createReadonlyTransport,createSpectatorView} from './src/ui/spectator.js';
import {createTouchControls,hasCoarsePointer,prefersReducedMotion} from './src/ui/touch-controls.js';
import {createFirstPlayGuide,renderNode} from './src/ui/first-play-guide.js';
import {planWalk} from './src/world-walk.js';
import {solidSceneryAt} from './src/footprints.js';
import {globeScene,countryGlobeCenter,rotateGlobe} from './src/country-globe.js';
import {validateCountryAtlas,atlasSelection,atlasViewBox} from './src/country-atlas.js';
import {tradeEvidencePreview} from './src/trade-preview.js';
import {parseTradeSubmissionDraft} from './src/trade-import.js';
import {tradeUrl,tradePairUrls} from './src/trade.js';
import {parseResearchFailure} from './src/research-failure.js';
import { ASSESSMENT_RESULTS } from './src/review-assessment.js';
import { clearOperatorState } from './src/browser-session.js';
import { normalizeDecisionBrief, serializeDecisionBrief, decisionBriefText } from './src/decision-brief.js';
import { draw, landmarkAt, start, landmarks, getWorldDefinition, walkable, terrainAt, drawMiniMap } from './world.js';
import { REGIONS, SDG_GOALS, CIVIC_CHARTER } from './src/civic.js';
import { createGameAudio } from './src/game-audio.js';

const $ = (selector) => document.querySelector(selector);
const gamePresentation = location.pathname !== '/manage' && new URLSearchParams(location.search).get('mode') !== 'workspace';
let savedGameMode = 'entry';
try { savedGameMode = sessionStorage.getItem('nemoworld-game-mode') || 'entry'; } catch { /* A private browser can still enter the world. */ }
if (!['entry','play','observe'].includes(savedGameMode)) savedGameMode = 'entry';
let savedFirstPerson = false;
// The camera choice has to outlive a tab: the tab's own sessionStorage is read first so a mid-session
// switch wins, and localStorage is the fallback that survives a browser restart.
try { savedFirstPerson = (sessionStorage.getItem('nemoworld-first-person') ?? localStorage.getItem('nemoworld-first-person')) === 'true'; } catch { /* The camera still works without storage. */ }
const state = { account: null, agents: [], world: { participants: [], messages: [], paused: false }, missions: [], tasks: [], gallery: [], history: { claims: [], submissions: [], reviews: [] }, safety: { reports: [], appeals: [] }, operations: null, tab: 'world', selected: localStorage.getItem('selected-agent') || '', setup: false, viewWorld: '', worlds: [], worldTotal: 0, worldQuery: '', worldOffset: 0, directoryHasMore: false, camera: { x: 0, y: 0 }, focus: null, building: false, buildKind: 'flowers', authMode: 'login', setupCodeRequired: false, community: {circles:[],projects:[],events:[],thanks:[],counts:{},pagination:{}}, communitySection: 'circles', communityQuery:'', communityOffset:0, journey:null };
// A private composer draft is scoped per operator, so it is loaded when the composer mounts rather
// than at boot (the account is unknown here). The legacy unscoped key is purged by clearChatDraft().
let savedChatDraft='';
Object.assign(state,{gamePresentation,gameMode:savedGameMode,gameDrawer:'',gameMenuOpen:false,chatChannel:'public',chatRecipientId:'',chatRecipientName:'',chatDraft:savedChatDraft});
// Audio is opt-in: creating the controller is side-effect free and the first
// sound-producing call only happens from a control click in the game menu.
const gameAudio = createGameAudio();
Object.assign(state,{missionQuery:{},missionPage:{missions:[],tasks:[],total:0,offset:0,limit:12,has_more:false},workers:{resident:null,research:null},countries:[],assembly:null,research:{leads:[],counts:[]},mayors:[],ambassadors:[],ambassadorQuery:{q:'',group:''},ambassadorOffset:0,ambassadorIncludePaused:false,ambassadorProfile:null,researchQuery:{},countryQuery:'',countryGroup:'',countryPage:0,assemblyQuery:{},assemblyPage:0});
Object.assign(state,{graphics:localStorage.getItem('nemoworld-graphics')==='pixel'?'pixel':'voxel',registrationOpen:true,frontierPage:0,frontierData:null,voxelSelection:null,parcelSelection:null,landData:null,blockLayer:0,climbing:false,lookMode:false,firstPerson:savedFirstPerson,callings:null,memory:null,guilds:null,guildFilter:'',guildOffset:0,inspectedResident:null,facing:{yaw:Math.PI/4,pitch:0.62},blueprint:null,blueprintAnchor:null,blueprintReport:null,grantPreview:null,quests:null,questCatalog:null,guildProjects:null,guildProjectQuery:'',guildProjectGuild:'',guildProjectOffset:0,eventStream:null,restoration:null,restorationEventId:'',firstPlay:null,firstPlayRefusal:null,interaction:null,interactionRefusal:null,interactionError:null,evidenceLibrary:null,moveFeedback:null});
let voxelView=null,heroVoxel=null,walkVersion=0,motionRevision=0,walkActive=false;
const movementQueue = createMovementQueue({ move: performMove });
const mayorSprites=new Map();for(const id of [1,2,3,5,6,7,9,10,11,12,13,14,15,16,17,18,19,20,21,22]){const image=new Image();image.src=`/assets/mayors/characters/${id}.png`;image.onload=()=>paintWorld();mayorSprites.set(id,image);}
const colors = { '#3d5875': 'blue', '#8c6ab1': 'purple', '#cb725f': 'coral', '#397f79': 'teal', '#aa7845': 'gold' };

// ---------------------------------------------------------------------------------------------
// The game shell's modules. Four parallel tasks delivered components (build, inventory, interaction
// prompt, spectator, touch) and one delivered the input controller; this is the one place they are
// constructed, fed the server's own payloads and mounted. Nothing here authors a world fact: every
// displayed value is a server field and every write still goes through the shipped `api()` call.
// ---------------------------------------------------------------------------------------------
let gameInput = null, spectator = null, touchControls = null;
let firstPlayReadTimer = null, firstPlayReadRevision = 0;
const pickListeners = new Set();
const shellPicker = { currentPick: () => state.voxelSelection, subscribe: (listener) => { pickListeners.add(listener); return () => pickListeners.delete(listener); } };
function notifyPick(pick) { for (const listener of [...pickListeners]) listener(pick); }
const hotbar = createHotbar({ input: shellPicker, onSelect: (type) => { if (type) placement.setKind(type); } });
const placement = createPlacementPreview({ api: (path, method, body) => api(path, method, body), input: shellPicker, onNotice: (text) => notice(text) });
const inventory = createInventoryPanel({ api: (path, method, body, idempotent, key) => api(path, method, body, idempotent, key), onNotice: (text) => notice(text) });
const interactionPrompt = createInteractionPrompt({
  transport: {
    interactRead: (query) => api(`/interact?${new URLSearchParams(query)}`),
    interactWrite: (payload, key) => api('/interact', 'POST', payload, false, key),
    sendMessage: (payload) => api('/messages', 'POST', { ...payload, world_id: currentWorldId() }),
  },
});
// The in-world guide. It reads the server's own `first-play` payload and sends each of its actions
// through the same `api()` call every other control uses, so it can never author a world fact. Its
// dismissal is a display preference kept inside the module; nothing here persists progress.
const firstPlayGuide = createFirstPlayGuide({
  transport: (route, method, body, idempotent) => api(route, method, body, idempotent),
  document,
  reducedMotion: prefersReducedMotion(window.matchMedia),
  // A conversation requires words from this operator. Opening an existing composer is not a
  // completed guide step; only its later saved message can advance the server-derived guide.
  onCompose: async (action) => {
    if(state.gameMode!=='play'||!viewedAgent())throw new Error('Choose Play and an active character before starting a conversation.');
    if(action.route==='/ambassadors/talk')return talkAmbassador(action.body?.ambassador_id,{agentId:action.body?.agent_id});
    if(action.route==='/messages'){
      const id=action.body?.recipient_id;
      const resident=state.world.participants.find(item=>item.id===id)||state.firstPlay?.encounter;
      if(!id||resident?.agent_id!==id&&resident?.id!==id)throw new Error('That AI resident is no longer nearby. Walk closer and try again.');
      return openCharacterConversation({id,name:resident.name,kind:'agent'});
    }
    throw new Error('That conversation is unavailable.');
  },
  onChange: () => mountFirstPlayGuide(),
  onAction: () => guarded(async () => { await refresh(); render(); }),
  // Dismiss and Resume are display-only, so they repaint the guide itself rather than rebuilding the
  // whole world; the module keeps the flag and `update()` leaves it alone, so the repaint stays dismissed.
  onDismiss: () => mountFirstPlayGuide(),
  onResume: () => mountFirstPlayGuide(),
});
const spectatorTransport = createReadonlyTransport({ fetch: (path, options) => fetch(path, options) });
gameInput = createGameInput({
  blocksView: createViewBlocker({
    isSolid: (x, y) => !walkable({ x, y }, definition()) || Boolean(solidSceneryAt({ x, y }, state.world.objects || [])),
    layerAt: (x, y) => surfaceAt(x, y, blockLayers(state.world.blocks || [])),
  }),
  worldContext: () => ({ frontier: definition().kind === 'frontier', palette: state.world.frontier?.palette || [], agent: Boolean(viewedAgent()), fixture: Boolean(state.interaction?.fixture), building: Boolean(state.building), lookMode: Boolean(state.lookMode) }),
  isSuspended: () => Boolean(state.gameMenuOpen || state.gameDrawer || document.querySelector('dialog[open]') || interactionPrompt.suspendsShortcuts),
  onIntent: handleIntent,
});
gameInput.setCameraMode(state.firstPerson ? 'first-person' : 'third-person', { silent: true });
gameInput.setFacing(state.facing);

/** The one place an intent becomes a shipped call. No intent carries a position the server did not store. */
function handleIntent(intent) {
  if (!intent) return;
  if (intent.kind === 'move') return void guarded(() => state.climbing ? climbAgent(intent.direction) : moveAgent(intent.direction));
  if (intent.kind === 'look') { queueLook(intent.yaw, intent.pitch, { apply: false }); applyFacing(); return; }
  if (intent.kind === 'interact') return void guarded(() => usePickedFixture());
  if (intent.kind === 'build') { state.buildKind = intent.type; state.building = true; renderView(); return; }
  if (intent.kind === 'camera') { setFirstPerson(intent.mode === 'first-person'); cancelLook(); gameInput.setFacing(state.facing); renderView(); return; }
}
const element = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
const append = (parent, ...children) => { parent.append(...children.filter(Boolean)); return parent; };
const button = (text, action, className = '') => { const node = element('button', text, className); node.type = 'button'; node.addEventListener('click', () => guarded(async () => { const result=action(); if(result && typeof result.then==='function'){node.disabled=true;node.setAttribute('aria-busy','true');try{return await result;}finally{node.disabled=false;node.removeAttribute('aria-busy');}}return result; })); return node; };
const paragraph = (text, className) => element('p', text, className);
const badge = (text, warning = false) => element('span', text.replaceAll('_', ' '), `badge ${warning ? 'warning' : text === 'demo' ? 'demo' : ''}`);
const actions = (...children) => append(element('div', null, 'actions'), ...children);
const card = (title, eyebrow) => { const node = element('section', null, 'card'); if (eyebrow) node.append(paragraph(eyebrow, 'eyebrow')); if (title) node.append(element('h2', title)); return node; };
const empty = (text) => paragraph(text, 'empty');
const selected = () => state.agents.find((agent) => agent.id === state.selected);
const titleOfTask = (id) => state.tasks.find((task) => task.id === id)?.title || state.history?.claims?.find(c=>c.task_id===id)?.task_title || state.history?.submissions?.find(s=>s.task_id===id)?.task_title || state.gallery?.find(s=>s.task_id===id)?.task_title || id;
const date = (value) => value ? new Date(value).toLocaleString() : '—';
const isReviewer = () => ['admin', 'reviewer'].includes(state.account?.role);
const isModerator = () => ['admin', 'moderator'].includes(state.account?.role);
// A newcomer's unfinished typing, remembered cursor and guided-path progress stay in this browser
// only. Nothing here is sent to the server, so a refresh never loses work in progress and never
// creates a draft record for anyone else to read. These functions touch only localStorage, which is
// why the block between the markers can be evaluated on its own in tests/newcomer-journey.test.js.
// newcomer-persistence:start
const DRAFT_PREFIX = 'nemoworld-draft:';
const NEWCOMER_KEY = 'nemoworld-newcomer';
const FOCUS_KEY = 'nemoworld-focus';
function storageGet(key) { try { return localStorage.getItem(key); } catch { return null; } }
function storageSet(key, value) { try { localStorage.setItem(key, value); return true; } catch { return false; } }
function storageRemove(key) { try { localStorage.removeItem(key); } catch { /* Best effort in a private window. */ } }
const CHAT_DRAFT_KEY='nemoworld-chat-draft';
// A private composer draft is the operator's own. Scope it the way focus and onboarding already are,
// so a shared browser never shows one operator's unsent private message to another. The legacy
// unscoped key is removed as well, so a draft left by an older build cannot leak either.
function chatDraftStorageKey(){return ownerStorageKey(CHAT_DRAFT_KEY);}
function clearChatDraft(){state.chatDraft='';storageRemove(chatDraftStorageKey());storageRemove(CHAT_DRAFT_KEY);}
function setChatDraft(value){state.chatDraft=value||'';if(state.chatDraft)storageSet(chatDraftStorageKey(),state.chatDraft);else storageRemove(chatDraftStorageKey());}
function scopedChatDraft(){return storageGet(chatDraftStorageKey())||'';}
let chatFocusBeforeRender=null;
function captureChatFocus(){const el=document.activeElement;if(!el||!el.closest('#world-chat-card form')){chatFocusBeforeRender=null;return;}chatFocusBeforeRender={name:el.name||'',start:el.selectionStart||null,end:el.selectionEnd||null};}
function restoreChatFocus(){const focus=chatFocusBeforeRender;chatFocusBeforeRender=null;const form=$('#world-chat-card form');if(!focus||!form)return;const el=form.elements.namedItem(focus.name);if(!el||!el.focus)return;el.focus({preventScroll:true});if(typeof el.selectionStart==='number'&&focus.start!==null){el.selectionStart=focus.start;el.selectionEnd=focus.end||focus.start;}}
function storedObject(key) { const text = storageGet(key); if (!text) return {}; try { const value = JSON.parse(text); return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; } catch { return {}; } }
const NEVER_DRAFT_FIELDS=/password|passphrase|secret|token|credential|setup_code|invite|consent/i;
function ownerStorageKey(key){return `${key}:${state.account?.id?'operator:'+state.account.id:'visitor'}`;}
function draftStorageKey(section){return state.account?.id&&!String(section).startsWith('auth-')?`${DRAFT_PREFIX}operator:${state.account.id}:${section}`:null;}
function draftValues(section){const key=draftStorageKey(section);if(!key)return{};const stored=storedObject(key),values={};for(const[name,value]of Object.entries(stored))if(!NEVER_DRAFT_FIELDS.test(name)&&typeof value==='string'&&value!=='')values[name]=value;return values;}
function saveDraftValues(section,values){const key=draftStorageKey(section),kept={};if(!key)return kept;for(const[name,value]of Object.entries(values||{}))if(!NEVER_DRAFT_FIELDS.test(name)&&typeof value==='string'&&value!=='')kept[name]=value;if(Object.keys(kept).length)storageSet(key,JSON.stringify(kept));else storageRemove(key);return kept;}
function clearDraftValues(section){const key=draftStorageKey(section);if(key)storageRemove(key);}
function rememberFocus(section,field){if(!section)return;storageSet(ownerStorageKey(FOCUS_KEY),JSON.stringify({section:String(section),field:String(field||''),at:Date.now()}));}
function rememberedFocus(){const stored=storedObject(ownerStorageKey(FOCUS_KEY));return{section:typeof stored.section==='string'?stored.section:'',field:typeof stored.field==='string'?stored.field:''};}
function forgetFocus(){storageRemove(ownerStorageKey(FOCUS_KEY));}
function newcomerProgress(){const stored=storedObject(ownerStorageKey(NEWCOMER_KEY));return{completed:[...new Set((Array.isArray(stored.completed)?stored.completed:[]).filter(id=>typeof id==='string'))],acknowledged:Boolean(stored.acknowledged)};}
function saveNewcomerProgress(progress){const next={completed:[...new Set((progress.completed||[]).filter(id=>typeof id==='string'))],acknowledged:Boolean(progress.acknowledged)};storageSet(ownerStorageKey(NEWCOMER_KEY),JSON.stringify(next));return next;}
function newcomerComplete(id,acknowledged=null){const progress=newcomerProgress();if(progress.completed.includes(id)&&(acknowledged===null||acknowledged===progress.acknowledged))return progress;return saveNewcomerProgress({completed:[...progress.completed,id],acknowledged:acknowledged===null?progress.acknowledged:acknowledged});}
// newcomer-persistence:end
function notice(message, error = false) { const node = error && $('#auth-dialog').open ? $('#auth-notice') : $('#notice'); node.textContent = message; node.className = error ? 'error' : ''; node.hidden = false; node.setAttribute('role',error?'alert':'status'); }
async function guarded(action) { try { await action(); } catch (error) { if(error.sessionEnded)return;notice(error.message || 'This action could not be completed.', true); } }
let sessionRecovery=null;
function clearBrowserOperator(){
 gameAudio.stop();spectator?.close();spectator=null;firstPlayGuide.reset();cancelFirstPlayRead();movementQueue.reset('session-ended');walkVersion++;motionRevision++;cancelLook();state.inspectedResident=null;state.memory=null;state.voxelSelection=null;state.parcelSelection=null;state.landData=null;state.interaction=null;state.interactionRefusal=null;state.grantPreview=null;state.restoration=null;state.restorationEventId='';state.firstPlay=null;state.firstPlayRefusal=null;state.evidenceLibrary=null;state.moveFeedback=null;clearOperatorState(state);state.workbenches=null;localStorage.removeItem('selected-agent');state.gameMode='entry';state.firstPerson=false;state.gameDrawer='';state.gameMenuOpen=false;state.chatChannel='public';state.chatRecipientId='';state.chatRecipientName='';state.chatDraft='';clearChatDraft();try{sessionStorage.removeItem('nemoworld-game-mode');sessionStorage.removeItem('nemoworld-first-person');sessionStorage.removeItem('nemoworld-observe-world');}catch{}try{localStorage.removeItem('nemoworld-first-person');}catch{}$('#credential-value').textContent='';for(const dialog of document.querySelectorAll('dialog[open]'))dialog.close();closeEventStream();presence.clear();render();
}
async function recoverBrowserSession(){
 if(sessionRecovery)return sessionRecovery;
 const liveWorld=spectator?.status().live?spectator.worldId():state.eventStream?.ready?state.eventStream.world:null;
 if(liveWorld)state.eventStreamClosed={world:liveWorld,reason:'session_revoked',at:Date.now()};
 clearBrowserOperator();notice('Your session ended. Sign in again to continue; saved drafts remain available.');
 sessionRecovery=(async()=>{try{await refresh(false);render();notice('Your session ended. Sign in again to continue; saved drafts remain available.');}catch{notice('Your session ended. Public pages could not refresh; try again when the world is reachable.',true);}finally{sessionRecovery=null;}})();return sessionRecovery;
}
async function api(path, method = 'GET', body, idempotent = false, requestKey=null) {
  const sessionEpoch=state.sessionEpoch||0;const operator=state.account?.id;
  const response = await fetch(`/api/v1${path}`, { method, credentials: 'same-origin', headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...((idempotent||requestKey) ? { 'Idempotency-Key': requestKey||crypto.randomUUID() } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const content = await response.json().catch(() => ({}));
  if(sessionEpoch!==(state.sessionEpoch||0))throw Object.assign(new Error('The operator session changed while this request was pending.'),{status:401,sessionEnded:true});
  if(operator&&(response.status===401||response.headers.get('X-Lucy-Session')==='expired')&&!path.startsWith('/auth/')){await recoverBrowserSession();throw Object.assign(new Error('Your session ended.'),{status:401,sessionEnded:true});}
  if (!response.ok) throw Object.assign(new Error(content.error || `Request failed (${response.status}).`),{status:response.status,body:content});
  return content;
}
function field(form, name, labelText, { type = 'text', options, required = true, value = '', max, min, hint, full = false } = {}) {
  const label = element('label', labelText, full ? 'full' : '');
  let input;
  if (options) { input = element('select'); for (const option of options) { const item = element('option', typeof option === 'string' ? option : option.label); item.value = typeof option === 'string' ? option : option.value; input.append(item); } }
  else input = element(type === 'textarea' ? 'textarea' : 'input');
  if (!options && type !== 'textarea') input.type = type;
  input.name = name; input.setAttribute('aria-label', labelText); input.required = required; if (!options || value !== '' || options.some((option) => (typeof option === 'string' ? option : option.value) === '')) input.value = value;
  if (max != null) type === 'number' ? input.max = max : input.maxLength = max;
  if (min != null) type === 'number' ? input.min = min : input.minLength = min;
  if (type === 'password') input.autocomplete = 'current-password';
  if (type === 'email') input.autocomplete = 'email';
  if(type==='password'){const wrap=element('span',null,'password-field');const reveal=button('Show',()=>{input.type=input.type==='password'?'text':'password';reveal.textContent=input.type==='password'?'Show':'Hide';reveal.setAttribute('aria-pressed',String(input.type==='text'));},'password-reveal');reveal.setAttribute('aria-label',`Show or hide ${labelText.toLowerCase()}`);reveal.setAttribute('aria-pressed','false');wrap.append(input,reveal);label.append(wrap);}else label.append(input);
  // Every control states whether it must be filled in, so no required field is only implied by a
  // red border or by a failed submit. The native required flag still blocks an empty submit.
  label.append(element('small', [required ? 'Required.' : 'Optional.', hint].filter(Boolean).join(' '), 'hint field-requirement')); form.append(label);const draftSection=form.closest('form')?.dataset.draftSection;if(draftSection){const remembered=draftValues(draftSection);if(Object.hasOwn(remembered,name))input.value=remembered[name];} return input;
}
function form(parent, submitLabel, callback, section = null) {
  const node = element('form'); const controls = element('div', null, 'field-grid'); const submit = element('button', submitLabel); submit.type = 'submit';
  if (section) { node.dataset.draftSection = section; attachLocalDraft(node, section); }
  node.append(controls, submit); node.addEventListener('submit', (event) => { event.preventDefault(); guarded(async () => { submit.disabled = true; const originalText=submit.textContent; submit.textContent='Working…';node.setAttribute('aria-busy','true'); try { await callback(Object.fromEntries(new FormData(node)), node); if (section) { clearDraftValues(section); forgetFocus(); } } finally { submit.disabled = false; submit.textContent=originalText;node.removeAttribute('aria-busy'); } }); });
  parent.append(node); return controls;
}
// A locally kept draft: the field values are written to this browser as they are typed, restored
// when the form is built again after a refresh, and cleared only after a successful submit. The
// remembered control is the one the newcomer's cursor was last in.
function attachLocalDraft(node, section) {
  const remembered = draftValues(section);
  for (const control of node.querySelectorAll('[name]')) {
    if (!Object.hasOwn(remembered, control.name)) continue;
    if (control.type === 'checkbox') control.checked = remembered[control.name] === 'on';
    else control.value = remembered[control.name];
  }
  const collect = () => { const values = {}; for (const control of node.querySelectorAll('[name]')) { if (control.type === 'checkbox') { if (control.checked) values[control.name] = 'on'; continue; } if (control.value !== '') values[control.name] = control.value; } return values; };
  node.addEventListener('input', () => saveDraftValues(section, collect()));
  node.addEventListener('change', () => saveDraftValues(section, collect()));
  node.addEventListener('focusin', (event) => { if (event.target?.name) rememberFocus(section, event.target.name); });
  return node;
}
function restoreRememberedFocus() {
  const remembered = rememberedFocus();
  if (!remembered.field) return false;
  const form = document.querySelector(`form[data-draft-section="${remembered.section}"]`);
  const control = form ? form.querySelector(`[name="${remembered.field}"]`) : null;
  if (!control) return false;
  for (let disclosure = control.closest('details'); disclosure; disclosure = disclosure.parentElement?.closest('details')) disclosure.open = true;
  control.focus({ preventScroll: true });
  return true;
}
function disclosure(parent, title, build) { const node = element('details'); node.append(element('summary', title)); const body = element('div'); node.append(body); build(body); parent.append(node); return node; }
function heading(title, description) { const node = element('div', null, 'section-title'); const text = element('div'); append(text, element('h2', title), paragraph(description)); node.append(text); return node; }
function facingForResident(resident) {
  // A new human starts toward the long open Commons, while a stored look always wins.
  if(resident?.kind==='human'&&resident.last_look===0&&resident.world_id==='commons'&&resident.x===10&&resident.y===6)return {yaw:-3*Math.PI/4,pitch:-.08};
  return {yaw:Number.isFinite(resident?.yaw)?resident.yaw:Math.PI/4,pitch:Number.isFinite(resident?.pitch)?resident.pitch:.62};
}
async function selectAgent(id) { cancelFirstPlayRead();movementQueue.reset('character-changed');walkVersion++;motionRevision++;cancelLook();state.inspectedResident=null;state.callings=null;state.memory=null;state.quests=null;state.guildProjects=null;state.restoration=null;state.restorationEventId='';state.firstPlay=null;state.firstPlayRefusal=null;state.blueprintReport=null;state.blueprintAnchor=null;state.voxelSelection=null;state.interaction=null;state.interactionRefusal=null;state.moveFeedback=null;state.chatChannel='public';state.chatRecipientId='';state.chatRecipientName='';state.chatDraft='';clearChatDraft();state.selected = id; state.viewWorld = ''; state.focus = null; state.building = false; setGameMode('play'); localStorage.setItem('selected-agent', id); await loadWorld(); await Promise.all([loadJourney(),loadCommunity(),loadCallings(),loadQuests(),loadGuildProjects(),loadRestoration(),loadFirstPlay()]);const resident=selected();if(resident){state.facing=facingForResident(resident);gameInput.setFacing(state.facing);}render(); }
function agentMark(agent) { return element('span', agent.symbol || '✦', `avatar-mark ${colors[agent.color] || 'teal'}`); }
function showCredential(value, description, title = 'Your connection credential') {
  $('#credential-title').textContent = title; $('#credential-description').textContent = description; $('#credential-value').textContent = value; $('#credential-dialog').showModal();
}
$('#close-credential').addEventListener('click', () => { $('#credential-value').textContent = ''; $('#credential-dialog').close(); });
$('#credential-dialog').addEventListener('close', () => { $('#credential-value').textContent = ''; });
$('#copy-credential').addEventListener('click', () => guarded(async () => { await navigator.clipboard.writeText($('#credential-value').textContent); notice('Copied. Store it in your agent’s private configuration.'); }));

function currentWorldId() { return state.viewWorld || selected()?.world_id || 'commons'; }
function viewedAgent() { if (state.viewWorld) return null; const agent = selected(); return agent && (!agent.world_id || agent.world_id === currentWorldId()) ? agent : null; }
// The server's world metadata can include an observed terrain viewport. The renderer needs the
// whole authored map for tiles beyond that viewport; state.world remains the observed overlay.
function definition() { const current = state.world.world || { id: currentWorldId() }; const authored = getWorldDefinition(current.id); return { ...authored, ...current, terrain: authored.terrain }; }
function worldPosition() { return viewedAgent() || state.focus || definition().start || start; }
function worldLandmarks() { return state.world.landmarks || definition().landmarks || landmarks; }
function worldPortals() { return state.world.portals || definition().portals || []; }
function portalLabel(portal) { const label=portal.label || portal.name || 'entrance'; return /^(enter|return)/i.test(label) ? label : `Enter ${label}`; }
function portalTarget(portal) { return portal.target_world_id || portal.targetWorldId; }
function cameraFor(position = worldPosition()) {
  const world = definition(); return { x: Math.max(0, Math.min((world.width || world.columns) - 20, Math.floor(position.x - 10))), y: Math.max(0, Math.min((world.height || world.rows) - 14, Math.floor(position.y - 7))) };
}
function paintWorld() {
  const canvas = $('#world'); if (!canvas) return; const owned = viewedAgent(); const agent=owned?{...owned,...state.world.participants.find(item=>item.id===owned.id)}:null;
  const audioPhase=state.world.atmosphere?.phase;if(audioPhase&&gameAudio.getState().phase!==audioPhase)gameAudio.setPhase(audioPhase);
  // Presentation applies the interpolation; the confirmed values in `state.world` are never rewritten.
  const now = performance.now(), base = worldPosition(), displayPosition = base?.id ? displayed(base, now) : base;
  state.camera = cameraFor(displayPosition);
  syncEventStream();
  if(state.graphics==='voxel'){if(!voxelView){voxelView=createVoxelWorld(canvas,{onPick:pick=>guarded(()=>pickWorld(pick)),onLook:look=>queueLook(look.yaw,look.pitch,{apply:false}),onUnavailable:()=>{if(state.graphicsUnavailable)return;state.graphics='pixel';state.graphicsUnavailable=true;queueMicrotask(()=>renderView());}});if(!voxelView)return;if(state.voxelOrbit)voxelView.setOrbit(state.voxelOrbit);}voxelView.render(state.world,{definition:definition(),position:displayPosition,self:agent||null,selection:state.voxelSelection,parcelSelection:state.parcelSelection,cameraMode:state.firstPerson&&agent?'first-person':'orbit',facing:state.facing,dayPhase:state.world.atmosphere?.phase});canvas.dataset.graphics='voxel';}
  else {draw(canvas, displayPosition, { blocks:state.world.blocks||[],world: definition(), camera: state.camera, objects: state.world.objects || [], portals: worldPortals(), visitors: state.world.participants.filter((a) => a.id !== agent?.id && a.status !== 'revoked').map((item) => displayed(item, now)), self: agent ? displayed(agent, now) : null, sprites:mayorSprites, dayPhase: state.world.atmosphere?.phase });canvas.dataset.graphics='pixel';}
  syncWorldControls();updateCallingHUD();const coordinates=$('#game-coordinates');if(coordinates)coordinates.textContent=`${Math.floor(displayPosition.x)}, ${Math.floor(displayPosition.y)}`;const population=$('#game-population');if(population)population.textContent=String(state.world.counts?.world_agents??state.world.population??state.world.participants.length);const overview=$('#world-overview');if(overview)drawMiniMap(overview,definition(),{camera:state.camera,position:agent||null,objects:state.world.objects||[],blocks:state.world.blocks||[],portals:worldPortals()});
}
function worldURL() { const position = cameraFor(); const query = new URLSearchParams({ view:state.graphics==='voxel'?'voxel':'pixel',world_id: currentWorldId(), x: String(Math.floor(position.x)), y: String(Math.floor(position.y)) }); if (selected() && state.account && state.gameMode!=='observe') query.set('agent_id', state.selected); return `/world?${query}`; }
const publicObserverMessage = (message) => Object.fromEntries(['id','author','text','created_at','world_id','channel'].filter(key=>message?.[key]!==undefined).map(key=>[key,message[key]]));
const publicObserverResident = (resident) => resident?.kind==='npc'?resident:Object.fromEntries(['id','name','kind','color','symbol','status','verified','x','y','z','grounded','yaw','pitch','world_id','posture','last_seen','emote','emote_until','presence','calling','title','avatar','accepted_contributions'].filter(key=>resident?.[key]!==undefined).map(key=>[key,resident[key]]));
function normalizeWorld(world) { return { ...world, participants: state.gameMode==='observe'?(world.participants||world.agents||[]).map(publicObserverResident):(world.participants||world.agents||[]), messages: state.gameMode==='observe' ? (world.messages||[]).filter(message=>message?.channel==='public').map(publicObserverMessage) : (world.messages||[]) }; }
async function loadWorld() { state.world = normalizeWorld(await api(worldURL())); seedPresence(state.world.participants); }

// ---------------------------------------------------------------------------------------------
// Shared-world presence. One bounded event subscription per client, and a presentation-only
// interpolation between the server's confirmed tiles (src/camera-controls.js `createPresenceTracker`).
//
// The authoritative position is always the server's: `state.world.participants` and the selected
// agent hold exactly what the server stored. Interpolation only ever draws the segment between two
// consecutive confirmed tiles and never passes the newest one, so the display can never claim a tile
// the server has not confirmed. A step of one tile glides; a longer jump (a travel or a world change)
// snaps. A refused step is reconciled immediately: the tween is dropped and the avatar is drawn at
// its stored tile again. A viewer who asked for reduced motion snaps on every step.
// ---------------------------------------------------------------------------------------------
const presence = createPresenceTracker({ now: () => performance.now(), reducedMotion: () => prefersReducedMotion(globalThis.matchMedia) });
let presenceFrame = 0;

/** Remember one server-confirmed position. A one-tile change glides from wherever the avatar is drawn. */
function noteConfirmed(item) {
  const record = presence.confirm(item);
  if (record && record.duration > 0) { schedulePresence(); return record; }
  return record;
}
function seedPresence(participants) { for (const item of participants || []) noteConfirmed(item); }
/** Draw an avatar where the interpolation currently places it; the record it came from is unchanged. */
function displayed(item, now) { return presence.record(item, now); }
/** The integer tile a drawn point falls in, for any text that must name one tile and not a fraction. */
function tileOf(point) { return { x: Math.floor(point.x), y: Math.floor(point.y), z: Number.isFinite(point.z) ? Math.round(point.z) : 0 }; }
/** Snap one avatar back to its stored tile: used when the server refuses a step. */
function reconcilePresence(id) {
  presence.reconcile(id);
  // The 3D view keeps its own tracker; a refusal snaps there too, so both views agree immediately.
  voxelView?.reconcileCharacter?.(id);
  if (state.tab === 'world' && $('#world')) paintWorld();
}
function presenceSettling(now) { return presence.settling(now); }
function schedulePresence() {
  if (presenceFrame || state.tab !== 'world') return;
  const step = () => {
    presenceFrame = 0;
    if (state.tab === 'world' && $('#world')) paintWorld();
    // A confirmed step glides in the 3D view too, so the loop keeps running while either tracker settles.
    if (presenceSettling(performance.now()) || voxelView?.isAnimating?.()) presenceFrame = requestAnimationFrame(step);
  };
  presenceFrame = requestAnimationFrame(step);
}

function closeEventStream() {
  const stream = state.eventStream;
  state.eventStream = null;
  if (stream?.source) { try { stream.source.close(); } catch { /* already closed */ } }
}
/** Keep exactly one live subscription, bound to the world currently on screen. */
function syncEventStream() {
  // Observation owns its one public live feed through the spectator component. The ordinary play
  // channel would open a duplicate connection and can race the observer's entitlement state.
  const world = state.account && state.gameMode!=='observe' ? currentWorldId() : null;
  if (!world || state.tab !== 'world') return closeEventStream();
  const stream = state.eventStream;
  if (stream && stream.world === world && !stream.closed) return;
  closeEventStream();
  if (typeof EventSource !== 'function') return; // an old browser keeps the polling fallback
  const source = new EventSource(`/api/v1/events?world_id=${encodeURIComponent(world)}`);
  const record = { world, source, ready: false, closed: false, errors: 0, updates: 0, lastAt: null };
  state.eventStream = record;
  source.addEventListener('ready', () => { record.ready = true; guarded(applyAuthoritativeSnapshot); });
  source.addEventListener('update', (event) => { try { applyWorldUpdate(JSON.parse(event.data)); } catch { /* a malformed frame is ignored */ } });
  source.addEventListener('closed', (event) => {
    record.closed = true;
    let reason = 'closed';
    try { reason = JSON.parse(event.data).reason || reason; } catch { /* keep the generic reason */ }
    try { source.close(); } catch { /* already closed */ }
    record.reason = reason;
    state.eventStreamClosed = { world: record.world, reason, at: Date.now() };
    if (reason === 'session_revoked') notice('Your session ended, so the live world feed stopped. Sign in again to resume it.');
    else if (reason === 'access_revoked') notice('This place is no longer open to you, so the live world feed stopped.');
  });
  source.addEventListener('error', () => {
    record.errors += 1;
    // A stream that never connects (a signed-out tab, a refused world) must not retry forever; the
    // ordinary polls keep the view current until the next repaint tries a fresh subscription.
    if (!record.ready && record.errors >= 5) { record.closed = true; try { source.close(); } catch { /* already closed */ } }
  });
}
/** A reconnect (or first connect) always re-reads the authoritative snapshot, so nothing diverges. */
async function applyAuthoritativeSnapshot() {
  if (movementQueue.inFlight || walkActive) return;
  const world = state.eventStream?.world;
  await loadWorld();
  if (!state.eventStream || state.eventStream.world !== world) return;
  seedPresence(state.world.participants);
  if (state.tab === 'world') { paintWorld(); refreshMessageList(); }
}
/** Apply one bounded frame: nearby avatars, saved objects, frontier blocks and public chat. */
function applyWorldUpdate(data) {
  if (!data || data.world_id !== currentWorldId()) return;
  const stream = state.eventStream;
  if (stream) { stream.updates += 1; stream.lastAt = performance.now(); if (Number.isFinite(data.t)) stream.lastLatencyMs = Date.now() - data.t; }
  const world = currentWorldId();
  state.world.participants = state.world.participants || [];
  const participants = state.world.participants;
  let unknown = false;
  for (const agent of data.agents || []) {
    if (!agent || typeof agent.id !== 'string') continue;
    const index = participants.findIndex((item) => item.id === agent.id);
    if (agent.world_id && agent.world_id !== world) { if (index >= 0) participants.splice(index, 1); continue; }
    if (index >= 0) Object.assign(participants[index],state.gameMode==='observe'?publicObserverResident(agent):agent);
    else unknown = true;
    noteConfirmed(agent);
    const owned = state.agents.find((item) => item.id === agent.id);
    if (owned) Object.assign(owned, agent);
  }
  state.world.objects = state.world.objects || [];
  for (const change of data.objects || []) {
    const index = state.world.objects.findIndex((item) => item.x === change.x && item.y === change.y);
    if (change.op === 'remove') { if (index >= 0) state.world.objects.splice(index, 1); }
    else if (index >= 0) Object.assign(state.world.objects[index], { type: change.type, kind: change.type });
    else state.world.objects.push({ type: change.type, kind: change.type, x: change.x, y: change.y });
  }
  state.world.blocks = state.world.blocks || [];
  for (const change of data.blocks || []) {
    const z = change.z || 0;
    const index = state.world.blocks.findIndex((item) => item.x === change.x && item.y === change.y && (item.z || 0) === z);
    if (change.op === 'remove') { if (index >= 0) state.world.blocks.splice(index, 1); }
    else if (index >= 0) Object.assign(state.world.blocks[index], change);
    else state.world.blocks.push({ x: change.x, y: change.y, z, type: change.type });
  }
  state.world.messages = state.world.messages || [];
  for (const message of data.messages || []) {
    if (!message?.id || state.world.messages.some((item) => item.id === message.id)) continue;
    if(state.gameMode==='observe'){if(message.channel!=='public')continue;state.world.messages.push(publicObserverMessage(message));}
    else state.world.messages.push(message);
  }
  if (state.world.messages.length > 200) state.world.messages = state.world.messages.slice(-200);
  // A participant this client has never seen is completed from the authoritative snapshot instead of
  // rendered half-known, and each world change repaints without rebuilding stable geometry.
  if (data.refresh || unknown) guarded(applyAuthoritativeSnapshot);
  else if (state.tab === 'world') { paintWorld(); refreshMessageList(); }
}
/** Replace the chat list, but never while someone is typing in it or in any other form. */
function refreshMessageList() {
  const messages = $('.message-list');
  if (!messages) return;
  const active = document.activeElement;
  if (active && (active.closest('form') || active.closest('.message-list'))) return;
  const replacement = chatCard().querySelector('.message-list');
  if (replacement) messages.replaceWith(replacement);
}
window.__nemoworld = {
  presence: () => presence.entries().map(([id, record]) => ({ id, confirmed: { ...record.confirmed }, display: displayCoords(record, performance.now()), tweening: presence.tweening(id) })),
  stream: () => state.gameMode==='observe'&&spectator ? {world:spectator.worldId(),ready:spectator.status().live,closed:!spectator.status().live,reason:spectator.status().reason,updates:spectator.frames()} : (state.eventStream ? { world: state.eventStream.world, ready: state.eventStream.ready, closed: state.eventStream.closed, reason: state.eventStream.reason || null, errors: state.eventStream.errors, updates: state.eventStream.updates, lastLatencyMs: state.eventStream.lastLatencyMs ?? null } : null),
  lastClosed: () => state.eventStreamClosed || null,
  world: () => state.world,
  worldId: () => currentWorldId(),
  terrainExtent: () => { const tiles = definition().terrain; return { rows: tiles.length, columns: tiles[0]?.length || 0 }; },
  selected: () => state.selected,
  gameMode: () => state.gameMode,
  drawer: () => state.gameDrawer,
  render: () => render(),
  nextAction: () => nextActionLine(),
  spectator: () => spectator ? { world: spectator.worldId(), status: spectator.status(), following: spectator.following(), target: spectator.target(), camera: spectator.camera(), refusal: spectator.lastRefusal(), residents: (spectator.snapshot()?.residents || []).map(resident => ({ id: resident.id, x: resident.x, y: resident.y })) } : null,
};
async function loadDirectory() { const result = await api(`/worlds?${new URLSearchParams({ q: state.worldQuery, offset: String(state.worldOffset), limit: '12' })}`); state.worlds = Array.isArray(result) ? result : result.worlds || result.items || []; state.worldTotal = result.total ?? state.worlds.length; state.directoryHasMore = result.has_more ?? state.worldOffset + state.worlds.length < state.worldTotal; }
async function loadAmbassadors() { state.ambassadorPage = await api('/ambassadors?' + new URLSearchParams({ q: state.ambassadorQuery.q || '', group: state.ambassadorQuery.group || '', offset: String(state.ambassadorOffset || 0), limit: '20',...(isModerator()&&state.ambassadorIncludePaused?{include_paused:'1'}:{}) })); state.ambassadors = state.ambassadorPage.entries || []; }
async function openAmbassador(id) { state.ambassadorProfile = await api('/ambassador?id=' + encodeURIComponent(id)); newcomerComplete('ambassador'); await openSection('civic'); }
async function visitWorld(id) { walkVersion++;$('#notice').hidden=true; await enterObservation(id,getWorldDefinition(id).start); }
let lastMotionAt = 0;
async function motionRequest(path, body) { const delay = Math.max(0, 160 - (performance.now() - lastMotionAt)); if (delay) await new Promise((resolve) => setTimeout(resolve, delay)); lastMotionAt = performance.now(); return api(path, 'POST', body); }
const wrapFacing = (value) => value >= -Math.PI && value <= Math.PI ? value : ((value + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI;
const clampFacing = (value) => Math.max(-1.4, Math.min(1.4, value));
let lookChain = Promise.resolve();
const lookScheduler = createLookScheduler({ send: () => sendLook() });
function cancelLook(){lookScheduler.cancel();}
function applyFacing() {
  if (!voxelView) return;
  voxelView.setCameraMode(state.firstPerson&&viewedAgent()?'first-person':'orbit');
  voxelView.setOrbit({ yaw: state.facing.yaw, pitch: state.facing.pitch });
}
function sendLook() {
  const agent = viewedAgent(); if (!agent||agent.status!=='active'||state.world.paused||!(state.lookMode||state.firstPerson)) return;
  const facing = { ...state.facing },epoch=state.sessionEpoch||0,id=agent.id;
  lookChain = lookChain.then(async()=>{
    if(epoch!==(state.sessionEpoch||0)||viewedAgent()?.id!==id)return;
    const result=await motionRequest(`/agents/${encodeURIComponent(id)}/look`,facing);
    if(epoch===(state.sessionEpoch||0)&&viewedAgent()?.id===id)Object.assign(agent,result);
  }).catch(error=>{if(!error.sessionEnded)notice(error.message||'The look could not be saved.',true);});
}
// One renderer owns dragging, and one scheduler coalesces the look requests it emits. A rotation
// only ever stores the facing: it never asks the server to move the resident.
function queueLook(yaw,pitch,{apply=true}={}) {
  state.facing={yaw:wrapFacing(yaw),pitch:clampFacing(pitch)};
  gameInput.setFacing(state.facing);
  if(apply)applyFacing();
  syncWorldControls();
  if(!viewedAgent()||!(state.lookMode||state.firstPerson))return;
  lookScheduler.request();
}
function lookStep(direction) {
  const facing=state.facing,step=.35;
  if(direction==='left')queueLook(facing.yaw+step,facing.pitch);
  else if(direction==='right')queueLook(facing.yaw-step,facing.pitch);
  else if(direction==='up')queueLook(facing.yaw,facing.pitch-step);
  else queueLook(facing.yaw,facing.pitch+step);
}
function toggleFirstPerson() {
  if(!viewedAgent())return;
  setFirstPerson(!state.firstPerson);cancelLook();
  renderView();
  notice(state.firstPerson?'First person: drag to look; WASD walks in your viewing direction. Q/E turn, R/F tilt. Step-up mode climbs one authored layer. Movement is one grid step at a time: there is no jump.':'Returned to the orbiting camera.');
}
function controlStep(direction,{keyboard=false}={}) {
  if(!viewedAgent())return moveAgent(direction);
  const intent=controlIntent(direction,{firstPerson:state.firstPerson,yaw:state.facing.yaw,lookMode:state.lookMode,keyboard});
  if(intent.kind==='look')return lookStep(direction);
  return state.climbing?climbAgent(intent.direction):moveAgent(intent.direction);
}
// Climbing uses the previewed neighbouring tile, the same pick the build path consumes.
function climbDirection() {
  const agent = viewedAgent(), target = state.voxelSelection;
  if (!agent || !target) return null;
  const dx = target.x - agent.x, dy = target.y - agent.y;
  if (Math.abs(dx) + Math.abs(dy) !== 1) return null;
  return dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up';
}
async function climbAgent(direction) {
  const agent=viewedAgent();if(!agent)return;
  walkVersion++;motionRevision++;const oldWorld=agent.world_id,epoch=state.sessionEpoch||0;
  let position;try{position=await motionRequest('/climb',{agent_id:agent.id,direction});}catch(error){reconcilePresence(agent.id);throw error;}
  if(epoch!==(state.sessionEpoch||0)||selected()?.id!==agent.id)return;
  const crossed=position.world_id!==oldWorld;Object.assign(agent,position);if(position.blocked)reconcilePresence(agent.id);
  if(crossed){state.focus=null;state.voxelSelection=null;state.building=false;state.inspectedResident=null;}
  await loadWorld();
  if(!position.blocked)scheduleFirstPlayRead();
  if(position.blocked)notice('Step-up requires a neighboring column no more than one layer higher and clear headroom.');
  if(state.tab==='world'&&state.graphics==='voxel'&&!crossed)paintWorld();else renderView();
}
async function climbPreview() {
  const direction = climbDirection();
  if (!direction) return notice('Pick a neighbouring tile first, then climb one block layer onto it.');
  await climbAgent(direction);
}
async function travelAgent(id) { movementQueue.reset('world-travel');walkVersion++;motionRevision++;if (!selected()) return; const result = await motionRequest(`/agents/${state.selected}/travel`, { world_id: id }); Object.assign(selected(), result.agent || result); selected().world_id = id; state.viewWorld = ''; state.focus = null; state.building = false; state.interaction=null; state.interactionRefusal=null;setGameMode('play'); await refresh(); state.tab = 'world'; render();
 // The arrival names the way back, so a journey is reversible in one action without opening a menu.
 const back=travelRoutes(worldPortals(),worldPosition(),{limit:1,home:`home:${state.selected}`})[0];
 const arrived=`Arrived in ${definition().name}.`;notice(back?`${arrived} ${back.label} at ${back.x}, ${back.y} leads back.`:arrived);
 reportMoveOutcome(moveFeedback({outcome:'travel',message:back?`Arrived in ${definition().name} · ${back.label} leads back.`:arrived}));
}
const portalJourney=createPortalJourney({
  walkTo,
  travelAgent,
  readState:()=>({actor:viewedAgent(),worldId:currentWorldId(),sessionId:state.sessionEpoch||0}),
});
async function enterPortal(portal){
  const actor=viewedAgent();
  if(!actor)return visitWorld(portalTarget(portal));
  const result=await portalJourney({portal,actor,sessionId:state.sessionEpoch||0});
  if(result.ok)return true;
  if(['cancelled','stale'].includes(result.reason))return false;
  const message=result.error?.message||({unreachable:'There is no walkable route to this entrance. Choose a clear path and try again.',refused:'The destination is unavailable for this character.',invalid:'This entrance has no valid destination.'}[result.reason])||'The journey could not be completed.';
  notice(message,true);return false;
}
async function refresh(all = true) {
  if (state.account && all) {
    const me = await api('/me'); state.account = me.account; state.agents = me.agents;
    if (!selected() && state.agents.length) state.selected = state.agents[0].id;
  }
  const [world, missions, gallery] = await Promise.all([api(worldURL()), api('/missions?'+new URLSearchParams({limit:'12',...state.missionQuery})), api('/gallery')]);
  state.world = normalizeWorld(world); state.missionPage=missions;mergeMissionContext(); state.gallery = Array.isArray(gallery) ? gallery : gallery.submissions || [];
  seedPresence(state.world.participants);
  await loadDirectory();
  if(!state.assembly){const [countries,assembly]=await Promise.all([api('/countries?limit=248'),api('/assembly')]);state.countries=countries.entries;state.assembly=assembly;}
  await loadResearch();state.mayors=(await api('/mayors')).mayors;await loadAmbassadors();
  await Promise.all([loadCommunity(),loadJourney(),loadCallings(),loadGuilds(),loadQuests(),loadGuildProjects(),loadRestoration(),loadFirstPlay()]);
  if (state.account && all) {
    state.history = await api('/history');mergeMissionContext(); state.workers=await api('/workers'); state.safety = await api('/safety');
    if (state.account.role === 'admin') state.operations = await api('/operations');
  }
}
function mergeMissionContext(){
 state.missions=[...new Map([...(state.history?.missions||[]),...(state.missionPage.missions||[])].map(item=>[item.id,item])).values()];
 state.tasks=[...new Map([...(state.history?.tasks||[]),...(state.missionPage.tasks||[])].map(item=>[item.id,item])).values()];
}
async function loadMissionPage(){state.missionPage=await api('/missions?'+new URLSearchParams({limit:'12',...state.missionQuery}));mergeMissionContext();}
async function showMissionTask(taskId){state.missionQuery={task_id:taskId};await loadMissionPage();openSection('missions');}
function missionDirectoryControls(parent){
 const filters=form(parent,'Search missions',async data=>{state.missionQuery={q:data.q,status:data.status,area:data.area,country:data.country,goal:data.goal,...(data.mine?{mine:data.mine}:{})};await loadMissionPage();renderView();});
 field(filters,'q','Mission or task title',{required:false,max:100,value:state.missionQuery.q||''});
 field(filters,'status','Mission status',{required:false,options:[{value:'',label:'All statuses'},...['open','paused','closed','demo','draft']],value:state.missionQuery.status||''});
 field(filters,'area','Mission area',{required:false,options:[{value:'',label:'All areas'},...['Climate','Peace','Accessibility','Agriculture','Health','Education','Water','Energy','Trade','Governance','Biodiversity','Development']],value:state.missionQuery.area||''});
 field(filters,'country','Linked country',{required:false,options:[{value:'',label:'All countries'},...state.countries.map(c=>({value:c.iso2,label:c.name}))],value:state.missionQuery.country||''});
 field(filters,'goal','Linked SDG',{required:false,options:[{value:'',label:'All goals'},...SDG_GOALS.map((name,index)=>({value:String(index+1),label:`SDG ${index+1} · ${name}`}))],value:state.missionQuery.goal||''});
 if(state.account)field(filters,'mine','Mission responsibility',{required:false,options:[{value:'',label:'All visible missions'},{value:'1',label:'My owned or assigned review missions'}],value:state.missionQuery.mine||''});
 if(state.missionQuery.task_id)parent.append(paragraph('Showing the mission containing the selected task. Search to return to the wider directory.','privacy'));
 parent.append(paragraph('Country and SDG filters apply to missions linked to research proposals. Other missions remain available under All countries and All goals.','privacy'));
}
function missionDirectoryPages(parent){const page=state.missionPage,previous=button('Previous missions',async()=>{state.missionQuery.offset=String(Math.max(0,page.offset-page.limit));await loadMissionPage();renderView();},'secondary');previous.disabled=!page.offset;const next=button('Next missions',async()=>{state.missionQuery.offset=String(page.offset+page.limit);await loadMissionPage();renderView();},'secondary');next.disabled=!page.has_more;parent.append(actions(previous,paragraph(`Page ${Math.floor(page.offset/page.limit)+1} · ${page.total} matching missions`,'privacy'),next));}
async function change(path, body, message, idempotent = false) { const result = await api(path, 'POST', body, idempotent); await refresh(); render(); if (message) notice(message); return result; }
function setGameMode(mode){
  if(mode!=='observe'){spectator?.close();spectator=null;}
  state.gameMode=mode;
  try{sessionStorage.setItem('nemoworld-game-mode',mode);if(mode!=='observe')sessionStorage.removeItem('nemoworld-observe-world');}catch{}
  applyGameShell();
}
function setFirstPerson(enabled){state.firstPerson=Boolean(enabled);try{sessionStorage.setItem('nemoworld-first-person',String(state.firstPerson));}catch{}try{localStorage.setItem('nemoworld-first-person',String(state.firstPerson));}catch{}gameInput.setCameraMode(state.firstPerson?'first-person':'third-person',{silent:true});}
function applyGameShell(){
  // A signed-in operator lands on the entry screen: Play, Observe and Continue are the door, and one
  // of them (or the world menu) is always how the world opens. `state.gameMode` is remembered in this
  // tab, so choosing play or observe is not repeated on every refresh.
  const world=state.gamePresentation&&state.tab==='world';
  const openingChat=world&&state.gameDrawer==='chat'&&!document.body.classList.contains('game-chat-open');
  if(openingChat){const stale=$('#notice');if(stale&&!stale.classList.contains('error'))stale.hidden=true;}
  if(!world)gameAudio.stop();
  document.body.classList.toggle('game-world',world);
  document.body.classList.toggle('game-entry',world&&state.gameMode==='entry');
  document.body.classList.toggle('game-menu-open',world&&state.gameMenuOpen);
  document.body.classList.toggle('game-tools-open',world&&state.gameDrawer==='tools');
  document.body.classList.toggle('game-chat-open',world&&state.gameDrawer==='chat');
  // The chat panel owns the pointer while it is open. The touch layer is switched off through its own
  // module (which hides it and stops its gestures) rather than by a rule in a main stylesheet, so the
  // touch class never leaks into the desktop shell.
  touchControls?.setEnabled(!(world&&state.gameDrawer==='chat'));
  // The guide remains mounted and server-derived while a conversation has the keyboard. Its
  // compact marker stays visible, and the conversation header offers a route back to its controls.
  const guideHost=$('#game-guide-host');if(guideHost)guideHost.inert=Boolean(world&&state.gameDrawer==='chat');
  document.body.classList.toggle('game-building',world&&state.building);
  document.body.dataset.gameDrawer=state.gameDrawer;
  $('#game-menu-button')?.setAttribute('aria-expanded',String(world&&state.gameMenuOpen));
  // A conversation owns the keyboard and the screen, so the touch layer is switched off through its
  // own control (which hides it *and* stops a held gesture) rather than by a stylesheet rule that
  // could not stop the pad's timers. This is the one place the layer's visibility is decided.
  syncTouchEnabled();
}
/** The touch layer is live only while the world is on screen and no conversation owns it. */
function syncTouchEnabled(){touchControls?.setEnabled(Boolean(state.gamePresentation&&state.tab==='world'&&state.gameDrawer!=='chat'));}
// One drawer at a time. `state.gameDrawer` holds a single value, so opening Chat closes the tools
// drawer, and the same button closes the one it opened.
function setGameDrawer(drawer){
  state.gameDrawer=state.gameDrawer===drawer?'':drawer;applyGameShell();
  if(state.gameDrawer==='chat'){const text=$('#world-chat-card [name="text"]');if(text)text.focus({preventScroll:true});}
  else if(state.gameDrawer==='tools')$('.world-aside')?.focus({preventScroll:true});
  else if(state.gameDrawer)$(`#world-${state.gameDrawer}-card`)?.scrollIntoView({block:'nearest'});
}
function toggleGameMenu(){state.gameMenuOpen=!state.gameMenuOpen;$('.sidebar')?.classList.toggle('navigation-open',state.gameMenuOpen);$('#toggle-navigation')?.setAttribute('aria-expanded',String(state.gameMenuOpen));applyGameShell();if(state.gameMenuOpen)$('#navigation button')?.focus({preventScroll:true});else $('#game-menu-button')?.focus({preventScroll:true});}
// Observation. The observer reads the public world with no account and no resident, through the
// read-only transport: the component can only issue the allow-listed public GETs, so nothing on this
// path can build, move a resident or speak for one. The live channel needs a session, so a visitor
// observes from the authoritative snapshot instead.
async function enterObservation(id,position){
  const next=createSpectatorView({read:spectatorTransport.get,start:position,subscribe:state.account?liveSubscribe:undefined});
  const opened=await next.open(id);
  if(!opened.ok){next.close();notice(`${opened.message} ${opened.next_step||''}`.trim(),true);return false;}
  movementQueue.reset('observer-mode');
  spectator?.close();spectator=next;
  setGameMode('observe');state.viewWorld=id;state.focus={x:position.x,y:position.y};state.building=false;state.interaction=null;state.interactionRefusal=null;setFirstPerson(false);state.gameDrawer='';
  try{sessionStorage.setItem('nemoworld-observe-world',id);}catch{}
  await loadWorld();state.tab='world';render();return true;
}
async function observeWorld(){
  const id=state.gameMode==='entry'?'commons':currentWorldId();
  const position=worldPosition();
  await enterObservation(id,id==='commons'?getWorldDefinition('commons').start:{x:position.x,y:position.y});
}
function render() { if(state.account||state.tab!=='world')$('#hero-introduction')?.pause(); document.body.classList.toggle('signed-in', Boolean(state.account)); document.body.classList.toggle('inner-section',(state.tab!=='world'||currentWorldId()!=='commons')); applyGameShell();renderSession(); renderAuth(); renderTabs(); renderView(); paintHero(); }
function paintHero(){
 const canvas=$('#hero-world');if(!canvas)return;const world=getWorldDefinition('commons');
 if(!heroVoxel&&!state.heroPixel){heroVoxel=createVoxelWorld(canvas,{onUnavailable:()=>{state.heroPixel=true;queueMicrotask(()=>{heroVoxel?.destroy();heroVoxel=null;const old=$('#hero-world');if(old){old.replaceWith(old.cloneNode(false));paintHero();}});}});if(!heroVoxel)return;}
 if(heroVoxel){heroVoxel.render({world,participants:[],objects:[],portals:world.portals||[]},{definition:world,position:world.start});canvas.dataset.graphics='voxel';}
 else{draw(canvas,start,{world,camera:{x:0,y:0},objects:[],portals:[],visitors:[],self:null});canvas.dataset.graphics='pixel';}
}
function openAuth(mode='login'){state.authMode=mode;renderAuth();$('#auth-notice').hidden=true;$('#auth-dialog').showModal();$('#auth-area section:not([hidden]) input')?.focus();}
$('#close-introduction').addEventListener('click',()=>{$('#introduction-film').pause();$('#introduction-dialog').close();});
$('#introduction-dialog').addEventListener('close',()=>$('#introduction-film').pause());
$('#close-auth').addEventListener('click',()=>$('#auth-dialog').close());
$('#close-characters').addEventListener('click',()=>$('#character-dialog').close());
function finishAuth(){if($('#auth-dialog').open)$('#auth-dialog').close();$('#auth-notice').hidden=true;}
// The entry screen. Three controls over the drawn world — Play, Observe and, when this browser
// remembers a character, Continue — plus the film as a text link under them. Each control is a real
// button, so the whole door is reachable with Tab and Enter. Every state shown comes from the server:
// `state.account` and `state.agents` from `GET /me`, and the world's pause from `GET /world`.
function continueCandidate(){
  if(!state.account||!state.agents.length)return null;
  return state.agents.find(agent=>agent.id===state.selected)||state.agents.find(agent=>agent.status==='active')||null;
}
function renderEntryControls(hero){
  const candidate=continueCandidate();
  if(candidate&&candidate.status==='active'){
    hero.append(button(`Continue as ${candidate.name}`,()=>selectAgent(candidate.id),'game-primary game-continue'));
  }
  hero.append(button('Play',()=>state.account?playAsHuman():openAuth('register'),candidate&&candidate.status==='active'?'game-secondary':'game-primary'));
  hero.append(button('Observe',()=>observeWorld(),'game-secondary'));
  if(candidate&&candidate.status!=='active'){
    hero.append(paragraph(`${candidate.name} is ${candidate.status}. Resume the character before entering the world.`,'game-entry-note'));
    hero.append(button('Manage characters',()=>openCharacterOverlay(),'game-secondary'));
  }
  const link=element('a','Watch the film (2 min)','game-film-link');link.href='#introduction-dialog';link.addEventListener('click',(event)=>{event.preventDefault();$('#hero-introduction')?.pause();$('#introduction-dialog').showModal();});
  const note=element('p',null,'game-entry-note');
  note.textContent=state.account?'Playing and continuing need an account; observing does not, and nothing observed is changed.':'No account is needed to look around. Playing needs an adult account, which is what manages the residents.';
  hero.append(link,note);
}
function renderSession() {
  const node=$('#session-bar');node.replaceChildren();const hero=$('#hero-actions');hero.replaceChildren();
  node.append(button('Watch introduction',()=>{$('#hero-introduction')?.pause();$('#introduction-dialog').showModal();},'secondary small'));
  if(state.account){const profile=element('div',null,'session-profile');append(profile,element('span',state.account.name.slice(0,1).toUpperCase(),'profile-avatar'),append(element('span',null,'session-label'),element('strong',state.account.name),element('small',state.account.role)));node.append(profile,button('Sign out',async()=>{try{await api('/auth/logout','POST',{});}catch(error){if(error.status!==401)throw error;}clearBrowserOperator();await refresh(false);render();notice('Signed out. Your agents and their world positions are saved.');},'secondary small'));}
  else {node.append(button('Sign in',()=>openAuth('login'),'secondary small'),button(state.setup?'Create first account':'Create account',()=>openAuth('register'),'small'));}
  if(!state.gamePresentation)node.append(button('Back to game',()=>{location.href='/';},'secondary small'));
  if(state.gamePresentation)renderEntryControls(hero);
  else hero.append(button(state.account?'Play in the world':'Create account & play',()=>state.account?playAsHuman():openAuth('register')),button('Explore the world',()=>{state.tab='world';renderTabs();renderView();$('#pixel-world-heading')?.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth',block:'start'});}),button('Find useful work',()=>browseResearch(),'secondary'),button(state.account?'Manage my characters':'Make a character',()=>state.account?openSection('characters'):openAuth('register'),'secondary'));
}
function renderAuth() {
  const node = $('#auth-area'); node.replaceChildren(); if (state.account) { finishAuth(); return; }
  $('#auth-title').textContent=state.authMode==='login'?'Welcome back':state.setup?'Plant the first seed':'Make yourself at home';const tabs=$('#auth-tabs');tabs.replaceChildren();for(const [mode,label]of[['login','Sign in'],['register',state.setup?'Create first account':'Create account']]){const item=button(label,()=>{state.authMode=mode;renderAuth();});item.setAttribute('aria-pressed',String(state.authMode===mode));tabs.append(item);}
  const grid = element('div', null, 'auth-panels'); const login = card('Welcome back', 'OPERATOR ACCESS'); login.append(paragraph('Sign in to manage your agents and oversee their time in the world.', 'muted'));
  const inputs = form(login, 'Sign in', async (data, node) => { const result = await api('/auth/login', 'POST', data); node.reset();state.sessionEpoch=(state.sessionEpoch||0)+1; state.account = result.account; finishAuth(); await refresh(); render(); notice('Welcome back. Choose a character to enter the world.'); });
  field(inputs, 'email', 'Email', { type: 'email' }); field(inputs, 'password', 'Password', { type: 'password', max: 128 });
  const signup = card(state.setup ? 'Plant the first seed' : 'Join the community', 'CREATE AN OPERATOR ACCOUNT');
  signup.append(paragraph(state.setup ? 'The first account becomes the local administrator. You can then invite operators, reviewers, and moderators.' : 'Create an adult account to play as yourself and build alongside agents. Your account also manages any AI characters you create.', 'muted'));
  const register = form(signup, state.setup ? 'Create the first account' : 'Create account', async (data, node) => { const result = await api('/auth/register', 'POST', { ...data, consent: data.consent === 'on' }); node.reset();state.sessionEpoch=(state.sessionEpoch||0)+1; state.account = result.account; state.setup = false; finishAuth();await refresh();if(data.entry==='human')await playAsHuman();else{state.tab='characters';render();notice('Your account is ready. Create an agent character.');} });
  field(register, 'name', 'Operator display name', { max: 40 }); field(register, 'email', 'Private contact email', { type: 'email', max: 254 });
  const password = field(register, 'password', 'Password', { type: 'password', min: 12, max: 128, hint: 'At least 12 characters.' }); password.autocomplete = 'new-password';
  if(state.setup && state.setupCodeRequired){const setupCode=field(register,'setup_code','Private setup code',{type:'password',max:256,full:true,hint:'Use the private code from your hosting dashboard to create the first administrator. Keep it confidential.'});setupCode.autocomplete='off';}
  field(register,'entry','How would you like to enter?',{options:[{value:'human',label:'Play as myself'},{value:'agent',label:'Create AI agents'}],value:'human',full:true});if(!state.setup)field(register,'invite','Invitation code (optional)',{max:100,required:!state.registrationOpen,hint:state.registrationOpen?'No invitation needed for a member account. Reviewer and moderator invitations come from an administrator.':'Public signup is closed; ask an administrator for an invitation.'});
  const consent = element('label', null, 'checkbox full'); const checkbox = element('input'); checkbox.type = 'checkbox'; checkbox.name = 'consent'; checkbox.required = true; append(consent, checkbox, element('span', 'I am 18 or older, agree to respectful participation, and accept responsibility for my agents and their contributions.')); register.append(consent);
  login.hidden=state.authMode!=='login';signup.hidden=state.authMode!=='register';append(grid,login,signup);node.append(grid);
}
function renderTabs() {
  const groups=[{title:'THE WORLD',items:[['start','Start here','◇'],['world','Open world','⌂'],['explore','Explore worlds','◇'],['list','World list','☷'],['civic','Regions & ambassadors','◇'],['countries','Countries & areas','◇'],['community','Community','♡'],['callings','Callings & guilds','✦'],['guilds','Guild projects','⚒'],['restoration','World restoration','✿'],['quests','Quest chains','◇']]},{title:'RESEARCH & CONTRIBUTIONS',items:[['research','Research desk','⚑'],['missions','Missions','⚑'],['gallery','Gallery','✧'],['assembly','World Assembly','◇']]}];
  if(state.account)groups.push({title:'YOUR RESIDENTS',items:[['coins','Coin wallet','✧'],['passport','Resident passport','♟'],['workshop','Garden & workshop','✿'],['characters','My characters','♟'],['history','My contributions','▤']]});
  // Governance, administration and diagnostics leave the newcomer's path. The game menu offers one
  // role-gated Management entry that opens /manage, where the same sections are rendered in full; the
  // workspace presentation keeps the complete governance group. The server's own role checks are the
  // authority for every route behind it either way.
  const privileged=isReviewer()||isModerator();
  if(!state.gamePresentation){const care=[];if(isReviewer())care.push(['review','Review','✓'],['owner','Mission studio','✎']);if(state.account)care.push(['safety','Safety','♡']);if(state.account?.role==='admin')care.push(['operations','Administration','⚙']);if(care.length)groups.push({title:'GOVERNANCE',items:care});}
  groups.push({title:'',items:[['help','Guide','?']]});
  const nav=$('#navigation');nav.replaceChildren();const current=groups.flatMap(group=>group.items).find(item=>item[0]===state.tab);$('#toggle-navigation').textContent='Menu · '+(current?.[1]||'NemoWorld');for(const group of groups){const section=element('div',null,'nav-group');if(group.title)section.append(paragraph(group.title,'nav-heading'));for(const[id,name,icon]of group.items){const item=button(name,()=>navigateSection(id));const names={world:'map',explore:'compass',list:'users-round',civic:'earth',countries:'earth',assembly:'users-round',research:'clipboard-list',missions:'clipboard-list',gallery:'sparkles',characters:'house',history:'book-open',review:'shield-check',owner:'sprout',safety:'shield-check',operations:'settings',help:'book-open',coins:'sparkles',community:'users-round',passport:'compass',workshop:'sprout',callings:'sparkles',guilds:'users-round',quests:'clipboard-list',restoration:'users-round',start:'book-open'};const image=element('img',null,'nav-icon');image.src=`/assets/icons/${names[id]}.svg`;image.alt='';image.setAttribute('aria-hidden','true');item.prepend(image);item.setAttribute('aria-label',name);if(id===state.tab)item.setAttribute('aria-current','page');section.append(item);}nav.append(section);}
  if(state.gamePresentation){const section=element('div',null,'nav-group game-workspace-link');section.append(paragraph('MORE CONTROLS','nav-heading'));if(privileged)section.append(button('Management',()=>{location.href='/manage';},'secondary small'));section.append(button('Open workspace',()=>{location.href='/?mode=workspace';},'secondary small'));nav.append(section);}
  if(state.gamePresentation&&state.tab==='world'){const sound=element('div',null,'nav-group game-audio-menu');sound.append(paragraph('SOUND','nav-heading'),gameAudio.createControls(document));nav.prepend(sound);}
}
function renderView() { if(voxelView){state.voxelOrbit=voxelView.orbit;voxelView.destroy();voxelView=null;}document.body.classList.toggle('inner-section',(state.tab!=='world'||currentWorldId()!=='commons'));applyGameShell();
  captureChatFocus(); const node = $('#view'); node.replaceChildren(); const views = { start: renderStartJourney, world: renderWorld, explore: renderExplore, list: renderList, civic: renderCivic, countries:renderCountries, assembly:renderAssembly, research:renderResearch, missions: renderMissions, characters: renderCharacters, history: renderHistory, review: renderReview, gallery: renderGallery, owner: renderOwner, safety: renderSafety, operations: renderOperations, help: renderHelp, community: renderCommunity, coins:renderCoins, passport: renderPassport, workshop: renderWorkshop,callings:renderCallings,guilds:renderGuildProjects,restoration:renderRestoration,quests:renderQuests };
  (views[state.tab] || renderWorld)(node);node.setAttribute('aria-busy','false');restoreChatFocus();
}
function renderCivic(parent) {
  parent.append(heading('Regions & ambassadors', 'Explore twenty ecological districts and meet the country ambassadors. Ambassadors use published rules and registered country context; human moderators decide enforcement.'));
  renderAmbassadorDirectory(parent);
  const intro=card(CIVIC_CHARTER.name,'WORLD ASSEMBLY · OPERATING PILOT');
  append(intro,paragraph(CIVIC_CHARTER.mandate),paragraph(CIVIC_CHARTER.affiliation,'privacy'),paragraph(CIVIC_CHARTER.safeguard,'muted'));
  const goals=document.createElement('a');goals.href=CIVIC_CHARTER.source;goals.target='_blank';goals.rel='noopener noreferrer';goals.textContent='Explore the UN Sustainable Development Goals ↗';intro.append(goals);parent.append(intro);
  const atlas=element('div',null,'civic-atlas');
  for(const region of REGIONS){const node=element('article',null,`civic-region civic-region-${region.id}`);const scene=element('div',null,'civic-scene');scene.setAttribute('aria-hidden','true');scene.append(element('span',null,'civic-horizon'),element('span',null,'civic-land'));node.append(scene);const body=element('div',null,'civic-body');append(body,paragraph(`REGION ${String(region.order).padStart(2,'0')} · ${region.landscape}`,'eyebrow'),element('h3',region.name),paragraph(region.mayor.focus,'muted'));const guide=state.mayors.find(item=>item.id===region.mayor.id)||state.mayors.find(item=>item.region_id===region.id);const guideNode=element('div',null,'civic-mayor');append(guideNode,guidePortrait(guide),append(element('span'),element('strong',guide?.name||region.mayor.name),element('small',`${region.mayor.title} · ${guide?.status||'active'}`),element('small',guide?.ambassador?`Country ambassador ${guide.ambassador.name} (${guide.ambassador.iso3})`:'Compatibility alias pending')));if(isModerator())body.append(button(guide?.status==='paused'?'Resume ambassador':'Pause ambassador',async()=>{await api('/ambassadors/control','POST',{ambassador_id:guide.ambassador.id,status:guide.status==='paused'?'active':'paused'});state.mayors=(await api('/mayors')).mayors;state.ambassadorOffset=0;await loadAmbassadors();renderView();},'secondary small'));body.append(paragraph('Research lens · SDGs '+region.researchGoals.join(', '),'privacy'),guideNode,actions(button('Explore related research',()=>openRegionResearch(region.id),'secondary small'),button('Visit district',()=>visitWorld(`district:${region.id}`),'secondary small'),button('Talk to this ambassador',()=>talkAmbassador(guide?.ambassador?.id||region.mayor.id),'small')));node.append(body);atlas.append(node);}parent.append(atlas);
  const program=card('A research agenda, with evidence at every step','WORLD ASSEMBLY · RESEARCH DESK');program.append(paragraph('The 17 UN Sustainable Development Goals are a source framework for research. World Assembly projects need a named owner, beneficiary, sources, rights, review rubric, and adoption route before agents work on them.','muted'));const chips=element('div',null,'civic-goals');SDG_GOALS.forEach((goal,index)=>chips.append(badge(`${index+1}. ${goal}`)));program.append(chips);const pilot=element('div',null,'civic-pilot');append(pilot,element('h3','First pilot · agricultural market access'),paragraph('Research one crop in one country: production and quality standards, official export rules, plausible buyers, logistics, contacts, and bilateral trade barriers. Deliver a cited brief to a consenting municipality or ministry for human review. No recipient or trade outcome is presumed.'));program.append(pilot);parent.append(program);
}
async function browseResearch(){state.researchQuery={};await loadResearch();await openSection('research');}
function renderAmbassadorDirectory(parent){
  const page=state.ambassadorPage||{},offset=state.ambassadorOffset||0;
  const panel=card('Country ambassadors · one per catalog entry','COUNTRIES & AREAS');panel.id='ambassador-directory';
  panel.append(paragraph('The catalog holds countries AND areas: a statistical list, not a list of sovereign states. Each entry has one ambassador holding a stand in its own generated country venue. An ambassador answers only from that country’s registered context, never as a government or a United Nations official. Paused ambassadors are withheld from this public listing.'));
  const filters=form(panel,'Find a country ambassador',async data=>{state.ambassadorQuery={q:data.q||'',group:data.group||''};state.ambassadorOffset=0;await loadAmbassadors();renderView();});
  field(filters,'q','Search',{required:false,value:state.ambassadorQuery.q||'',max:80,hint:'Matches name, ISO2, ISO3, M49 code, region or subregion.'});
  field(filters,'group','Country grouping',{required:false,value:state.ambassadorQuery.group||'',options:[{value:'',label:'All countries and areas'},{value:'ldc',label:'Least developed countries (LDC)'},{value:'lldc',label:'Landlocked developing countries (LLDC)'},{value:'sids',label:'Small island developing States (SIDS)'}]});
  if(isModerator()){const toggle=button(state.ambassadorIncludePaused?'Hide paused ambassadors':'Include paused ambassadors',async()=>{state.ambassadorIncludePaused=!state.ambassadorIncludePaused;state.ambassadorOffset=0;await loadAmbassadors();renderView();},'secondary small');toggle.setAttribute('aria-pressed',String(state.ambassadorIncludePaused));panel.append(toggle);}
  const grid=element('div',null,'grid three');
  for(const entry of state.ambassadors){
    const node=card(entry.name,entry.country_group.toUpperCase());
    node.append(paragraph(`${entry.iso3} · ${entry.iso2} · M49 ${entry.m49}`,'privacy'),paragraph(`${entry.region||'No region recorded'}${entry.subregion?' · '+entry.subregion:''}`,'muted'),paragraph(`Venue ${entry.world_id}`,'privacy'));
    node.append(actions(button('Talk to this ambassador',()=>talkAmbassador(entry.id),'small'),...countryVenueButtons(entry.world_id),button('Open profile',()=>guarded(()=>openAmbassador(entry.id)),'secondary small')));
    grid.append(node);
  }
  if(!state.ambassadors.length)grid.append(empty('No country ambassador matches this search.'));
  panel.append(grid,paragraph(`${page.total??0} matching of ${page.catalog?.total??0} catalog entries · page ${Math.floor(offset/20)+1}${page.excluded?.not_shown?` · ${page.excluded.not_shown} paused entr${page.excluded.not_shown===1?'y':'ies'} withheld`:''}`,'privacy'));
  const previous=button('Previous page',async()=>{state.ambassadorOffset=Math.max(0,offset-20);await loadAmbassadors();renderView();},'secondary small');previous.disabled=offset<=0;
  const next=button('Next page',async()=>{state.ambassadorOffset=offset+20;await loadAmbassadors();renderView();},'secondary small');next.disabled=!page.has_more;
  panel.append(actions(previous,next));
  parent.append(panel);
  if(state.ambassadorProfile)parent.append(renderAmbassadorProfileCard(state.ambassadorProfile));
}
function renderAmbassadorProfileCard(profile){
  const node=card(`${profile.country.name} · country ambassador`,'COUNTRY PROFILE');node.id='country-ambassador-profile';node.tabIndex=-1;
  node.append(paragraph(`${profile.country.iso3} · ${profile.country.iso2} · M49 ${profile.country.m49} · ${profile.country.region||'No region recorded'}${profile.country.subregion?' · '+profile.country.subregion:''}`,'privacy'),paragraph(`${profile.remit.fictional} ${profile.remit.limits}`,'privacy'));
  node.append(paragraph(`Venue ${profile.venue.world_id} · stand ${profile.venue.x}, ${profile.venue.y}`,'privacy'),paragraph(profile.venue.route,'privacy'));
  if(profile.legacy)node.append(paragraph(`Compatibility alias: the historic regional guide ${profile.legacy.guide_id} (${profile.legacy.region_name}) maps to this ambassador. Historic conversations stay readable below.`,'muted'));
  node.append(paragraph(`Country context captured ${date(profile.country_context.captured_at)}. Exact values, observation years and source dates come from retained records.`,'privacy'));
  if(isModerator())node.append(button(profile.ambassador.status==='paused'?'Resume ambassador':'Pause ambassador',async()=>{await api('/ambassadors/control','POST',{ambassador_id:profile.ambassador.id,status:profile.ambassador.status==='paused'?'active':'paused'});state.ambassadorProfile=await api('/ambassador?id='+encodeURIComponent(profile.ambassador.id));state.mayors=(await api('/mayors')).mayors;await loadAmbassadors();renderView();},'secondary small'));
  const sources=element('div',null,'mayor-sources');
  for(const source of profile.research.evidence_routes){const row=element('section',null,'mayor-source');row.append(element('h3',`${source.number}. ${source.name}`),paragraph(`${source.sector} · ${source.status==='retained'?'retained series':'no retained series'}`,'privacy'));if(source.definition_url)row.append(sourceLink(source.definition_url,'Indicator definition'));if(source.metadata_url)row.append(paragraph(''),sourceLink(source.metadata_url,'Provider metadata'));sources.append(row);}
  disclosure(node,'Registered country evidence',body=>body.append(sources));node.append(paragraph(profile.country_context.limitations,'privacy'));
  node.append(paragraph(`${profile.research.lead_total} research proposals recorded for ${profile.country.name}. A proposal is a work backlog, not completed research.`,'privacy'));
  if(profile.research.leads.length){const list=element('ul',null,'ambassador-leads');for(const lead of profile.research.leads)list.append(element('li',`${lead.title} · ${lead.status}`));node.append(list);}
  const turns=(state.account?[...(profile.conversations||[]),...(profile.legacy_conversations||[])]:[]).sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
  if(state.account)node.append(paragraph(`${profile.conversations.length} private conversation${profile.conversations.length===1?'':'s'} here${profile.legacy_conversations.length?` and ${profile.legacy_conversations.length} historic guide conversation${profile.legacy_conversations.length===1?'':'s'} preserved by the migration`:''}.`,'privacy'));
  else node.append(paragraph('Sign in to read your private conversations with this ambassador.','privacy'));
  node.append(actions(button('Talk to this ambassador',()=>talkAmbassador(profile.ambassador.id),'small'),...countryVenueButtons(profile.venue.world_id),button('Open '+profile.country.name+' research',async()=>{state.researchQuery={country:profile.country.iso2};await loadResearch();await openSection('research');},'secondary small'),button('Close profile',()=>{state.ambassadorProfile=null;renderView();},'secondary small')));
  if(turns.length){const transcript=element('div',null,'mayor-transcript');for(const turn of turns)renderGuideReply(transcript,turn);disclosure(node,'Private conversation history',body=>body.append(transcript));}
  return node;
}
// The newcomer journey: six concrete steps from arriving to understanding where independent human
// review begins. Every "done" state is either real server state (the account, the resident, the
// calling, a saved receipt) or the newcomer's own acknowledged reading, remembered in this browser.
// The two kinds of progress are kept visibly apart: cosmetic calling experience, and NemoCoins,
// which only the independent real-contribution ledger can issue. The figures in NEWCOMER_XP and
// NEWCOMER_COINS are the fallbacks shown to a signed-out visitor; tests/newcomer-journey.test.js
// asserts they equal CALLING_POLICY and COIN_POLICY, and the renderer prefers the live payload.
const NEWCOMER_XP = Object.freeze({ per_objective: 5, daily_limit: 10 });
const NEWCOMER_COINS = Object.freeze({ award: 10, operator_daily_limit: 100 });
const NEWCOMER_INTRO = 'Six steps take a newcomer from arriving to understanding how real work is reviewed: enter as a human or create an AI resident, choose a calling, meet a country ambassador, complete one saved practice activity, read its receipt, and see where independent human review begins.';
const NEWCOMER_CONTROLS = 'Controls, in both views. In the 3D world, drag to look and use W A S D or the arrow keys to walk; the aim line under the view names the tile you face and says whether it is solid. First person, Turn mode and Step-up mode are ordinary buttons with their state announced. If 3D graphics are unavailable in your browser, the same world falls back to the pixel map: the arrow buttons move one tile at a time, Walk to a tile plans a route from typed coordinates, and the World list is a text view of every place and participant. Nothing in this journey needs a mouse, a drag or a hover.';
function xpNumbers() { const policy = state.callings?.policy; return { per: Number.isInteger(policy?.experience_per_objective) ? policy.experience_per_objective : NEWCOMER_XP.per_objective, limit: Number.isInteger(policy?.daily_experience_limit) ? policy.daily_experience_limit : NEWCOMER_XP.daily_limit }; }
function coinNumbers() { const policy = state.journey?.coins?.policy; return { award: Number.isInteger(policy?.award) ? policy.award : NEWCOMER_COINS.award, limit: Number.isInteger(policy?.operator_daily_limit) ? policy.operator_daily_limit : NEWCOMER_COINS.operator_daily_limit }; }
// The practice receipt the flow can honestly call cosmetic: a calling objective, or a step of an
// authored *practice* chain. An acceptance receipt from real, independently reviewed work is not a
// practice activity, and a step of a real evidence chain is not either, so neither counts here.
function practiceReceipt() {
  const receipts = state.callings?.receipts || [], chains = state.quests?.chains || [];
  return receipts.find((receipt) => {
    const objective = String(receipt.objective_id || '');
    if (objective.startsWith('quest:')) return chains.find((chain) => chain.slug === objective.slice(6).split('.')[0])?.practice === true;
    return receipt.source_kind !== 'research_accepted';
  }) || null;
}
function markNewcomerStep(id, acknowledged = null) { newcomerComplete(id, acknowledged); if (state.tab === 'start') renderView(); }
function newcomerSteps() {
  const progress = newcomerProgress(), resident = selected(), calling = state.callings?.calling || null, receipt = practiceReceipt();
  const steps = [
    { id: 'enter', title: 'Enter as a human, or create an AI resident',
      detail: state.account ? `You are signed in as ${state.account.name}. The account is the adult who oversees its characters; a human player, one or more AI residents, or both can take part.` : 'An operator account is free to create and is responsible for the characters under it. You can also look around the whole world first, without one.',
      done: Boolean(state.account && resident),
      controls: state.account ? actions(button(resident ? 'Open my characters' : 'Create an AI resident', () => openSection('characters'), 'small'), button('Play as myself', () => playAsHuman(), 'secondary small')) : actions(button('Create an operator account', () => openAuth('register')), button('Sign in', () => openAuth('login'), 'secondary small')) },
    { id: 'calling', title: 'Choose a calling',
      detail: calling ? `${resident?.name || 'Your resident'} follows ${calling.name} · ${calling.guild_name}. A calling is a purpose and a guild affiliation; it grants no account role, land, permission or review authority.` : 'A calling gives your resident a purpose, a guild affiliation and two daily objectives. You choose it; an AI resident never chooses its own.',
      done: Boolean(calling),
      controls: actions(state.account ? button(calling ? 'Review or change the calling' : 'Choose a calling', () => openSection('callings'), 'small') : button('Create an account to choose a calling', () => openAuth('register'), 'small')) },
    { id: 'ambassador', title: 'Meet a country ambassador',
      detail: progress.completed.includes('ambassador') ? 'You have opened a country ambassador. Ambassadors answer only from that country’s registered, dated context and never as a government or United Nations official.' : 'Every catalog country and area has one ambassador, each standing in its own generated country venue. Reading one is how the research questions of a place become concrete.',
      done: progress.completed.includes('ambassador'),
      controls: actions(button('Meet the country ambassadors', () => openSection('civic'), 'small')) },
    { id: 'practice', title: 'Complete one saved practice activity',
      detail: receipt ? `A saved practice activity is on record: ${receipt.objective_id.replaceAll('_', ' ')} on ${receipt.earned_day}.` : 'A practice activity is something the server records anyway — walking into a place, planting and harvesting a crop, crafting a keepsake or placing a saved block. It is credited only from that saved fact, and it mints no coins.',
      done: Boolean(receipt),
      controls: actions(button('Open the calling objectives', () => openSection('callings'), 'secondary small'), button('Open the quest chains', () => openSection('quests'), 'secondary small')) },
    { id: 'receipt', title: 'Read its receipt',
      detail: receipt ? `The receipt below is the whole record: a saved source, one UTC day and ${xpNumbers().per} cosmetic experience.` : 'The receipt is the durable record of the activity: which saved fact credited it, on which day, and how much cosmetic experience it produced.',
      done: Boolean(receipt),
      controls: actions(button('Open my experience receipts', () => openSection('callings'), 'secondary small')) },
    { id: 'review', title: 'Understand how real contribution review works',
      detail: progress.acknowledged ? 'You have read the review boundary. Cosmetic progress and accepted real contributions are separate records, and only independent human acceptance mints a NemoCoin.' : 'Reaching a review boundary means your evidence waits for a different, authorized human being. You cannot accept your own work, and a model cannot accept it for you.',
      done: progress.acknowledged,
      controls: actions(button('Open a real mission', () => openSection('missions'), 'secondary small'), button('Read the review boundary again', () => { const target = document.getElementById('newcomer-review'); if (target) target.scrollIntoView({ block: 'start', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' }); else openSection('start'); }, 'secondary small')) },
  ];
  return steps;
}
// `only` renders a single step (its index in the six) for the compact home-page line; without it the
// whole ordered path is rendered for the guided start section.
function newcomerStepsList(only = null) {
  const steps = newcomerSteps(), list = element('ol', null, 'newcomer-steps'), firstOpen = steps.findIndex((step) => !step.done);
  steps.forEach((step, index) => {
    if (only !== null && index !== only) return;
    const standing = step.done ? 'done' : index === firstOpen ? 'next' : 'later';
    const item = element('li', null, `newcomer-step ${standing}`);
    item.setAttribute('aria-label', `Step ${index + 1} of ${steps.length}: ${step.title}. ${step.done ? 'Complete' : standing === 'next' ? 'This is your next step' : 'Waiting'}.`);
    item.append(element('h3', `Step ${index + 1} · ${step.title}`), badge(step.done ? 'complete' : standing === 'next' ? 'your next step' : 'waiting'));
    item.append(paragraph(step.detail, 'privacy'));
    item.append(step.controls);
    list.append(item);
  });
  return list;
}
function newcomerReceiptCard() {
  const receipt = practiceReceipt(), xp = xpNumbers(), coins = coinNumbers(), wallet = state.journey?.coins || null;
  const node = card('The receipt for your practice activity', 'SAVED SERVER RECORD'); node.id = 'newcomer-receipt';
  if (!receipt) { node.append(empty('No practice receipt yet. Complete one saved activity — the server credits it from the recorded fact alone.')); return node; }
  const table = element('table', null, 'evidence-table');
  const caption = element('caption', 'One practice receipt, exactly as the server stored it.');
  const head = element('thead'), headRow = element('tr'); for (const title of ['Field', 'Value']) headRow.append(element('th', title)); head.append(headRow);
  const body = element('tbody');
  for (const [label, value] of [['Objective', receipt.objective_id.replaceAll('_', ' ')], ['Saved source', `${receipt.source_kind} · ${receipt.source_id}`], ['Credited day (UTC)', receipt.earned_day], ['Cosmetic experience', `${receipt.points}`], ['State', receipt.available ? 'available' : 'held because its source changed']]) { const row = element('tr'); row.append(element('th', label), element('td', value)); body.append(row); }
  table.append(caption, head, body);
  node.append(table, paragraph(`This receipt is cosmetic participation, not currency: ${xp.per} experience per saved objective, at most ${xp.limit} per resident per UTC day, with no cash value and no transfers. Calling experience never becomes a NemoCoin.`, 'privacy'));
  node.append(paragraph(wallet ? `The same resident’s coin wallet holds ${wallet.balance} NemoCoin${wallet.balance === 1 ? '' : 's'} from ${wallet.receipt_count} reward receipt${wallet.receipt_count === 1 ? '' : 's'}. Practice activity mints nothing, so a practice-only resident stays at zero.` : `A practice activity mints no NemoCoins. NemoCoins are issued only when a different, authorized human being accepts a real scoped contribution, at a fixed ${coins.award} coins per accepted task and at most ${coins.limit} per operator per UTC day.`, 'privacy'));
  node.append(button('Open the full wallet and ledger', () => openSection('coins'), 'secondary small'));
  return node;
}
function newcomerBoundaryCard() {
  const xp = xpNumbers(), coins = coinNumbers(), progress = newcomerProgress();
  const node = card('Cosmetic progress, and real contribution review', 'THE ONE DISTINCTION THAT MATTERS'); node.id = 'newcomer-review';
  const grid = element('div', null, 'grid two');
  const cosmeticLane = element('article', null, 'newcomer-lane');
  cosmeticLane.append(element('h3', 'Cosmetic calling experience (XP)'), badge('calling · cosmetic'),
    paragraph(`What it records: bounded participation in the world, credited from a saved server fact — a calling objective or an authored quest step.`),
    paragraph(`How it is earned: ${xp.per} experience per completed objective, at most ${xp.limit} per resident per UTC day. One saved fact is credited once, by whichever objective or quest step the server reaches first.`),
    paragraph('What it can do: change a cosmetic rank title (Newcomer, Apprentice, Practitioner, Companion, Worldmaker). It cannot be transferred, spent, sold or exchanged, and it creates no authority.'));
  const coinLane = element('article', null, 'newcomer-lane');
  coinLane.append(element('h3', 'NemoCoins'), badge('real contribution · independently reviewed'),
    paragraph('What it records: one real scoped contribution that a different, authorized human reviewer accepted on a real mission with a named owner and reviewer.'),
    paragraph(`How it is earned: a fixed ${coins.award} coins per accepted task, one receipt per task, at most ${coins.limit} per operator per UTC day. The server sets the amount and the date; no client, model or character can mint, change or transfer a coin.`),
    paragraph('What reaching the review boundary means: your submitted evidence waits for that independent human. You cannot accept your own work, a sibling character of your operator cannot accept it, and an approval is not proof of external impact.'));
  grid.append(cosmeticLane, coinLane);
  node.append(grid, paragraph('A practice activity, a quest step, a guild pledge, a thank-you and a harvest all leave cosmetic or community records. None of them mints a NemoCoin: the only route from this world to a real reward is an independent human acceptance of a real task.', 'privacy'));
  const ack = button(progress.acknowledged ? 'Reviewed: I understand the review boundary' : 'I have read the review boundary', () => { const next = !progress.acknowledged; markNewcomerStep('review', next); notice(next ? 'Saved. Real contributions need a different, authorized human reviewer.' : 'Marked as not yet read. The explanation stays here.'); }, 'secondary small');
  ack.setAttribute('aria-pressed', String(progress.acknowledged));
  const controls = actions(ack, button('Open a real mission', () => openSection('missions'), 'secondary small'), button('Read the calling policy in the interface', () => openSection('callings'), 'secondary small'), button('Read the quest rules', () => openSection('quests'), 'secondary small'));
  if (isReviewer()) controls.append(button('Open the review queue', () => openSection('review'), 'secondary small'));
  node.append(controls);
  return node;
}
function newcomerControlsCard() {
  const node = card('Moving around, and the map fallback', 'CONTROLS IN THIS FLOW'); node.id = 'newcomer-controls';
  node.append(paragraph(NEWCOMER_CONTROLS), paragraph('Movement is one grid step at a time. Water, trees, buildings and furniture shape the paths; stepping into them is refused and your position stays where it was. Climbing one authored layer uses Step-up mode, and there is no jumping or continuous airborne physics.', 'privacy'));
  node.append(button('Open the world and its controls', () => openSection('world'), 'secondary small'), button('Manage my characters', () => openSection('characters'), 'secondary small'));
  return node;
}
function newcomerJourneyCard({ compact = false } = {}) {
  const progress = newcomerProgress(), steps = newcomerSteps(), done = steps.filter((step) => step.done).length;
  const node = card('Your first six steps', 'GUIDED START'); node.id = 'newcomer-journey'; node.classList.add('newcomer-journey');
  node.append(paragraph(NEWCOMER_INTRO));
  const bar = element('progress'); bar.max = steps.length; bar.value = done; bar.setAttribute('aria-label', `${done} of ${steps.length} guided steps complete`);
  node.append(bar, paragraph(`${done} of ${steps.length} complete. Progress is remembered in this browser, so a refresh returns you to the step you were on${progress.completed.includes('ambassador') ? ' with the ambassador you met' : ''}.`, 'privacy'));
  if (!compact) node.append(newcomerStepsList());
  else {
    // The home page shows only the step that is waiting, so a returning resident is not lectured.
    const next = steps.findIndex((step) => !step.done);
    if (next >= 0) node.append(newcomerStepsList(next));
    else node.append(paragraph('All six steps are complete. Nothing further is owed: the world, its callings and its review boundaries are open to you.', 'privacy'));
    node.append(actions(button('Open the guided journey', () => openSection('start'), 'small'), button('Coin wallet', () => openSection('coins'), 'secondary small')));
  }
  return node;
}
function renderStartJourney(parent) {
  parent.append(heading('Start here', 'This is the whole newcomer path in text: six steps, the receipt they produce, the controls in both views, and the difference between cosmetic progress and reviewed real contribution. Every step is an ordinary button or field, and no window opened here traps the keyboard.'));
  parent.append(newcomerJourneyCard());
  parent.append(newcomerReceiptCard());
  parent.append(newcomerBoundaryCard());
  parent.append(newcomerControlsCard());
  if (!state.account) parent.append(paragraph('Browsing is open to visitors: the ambassadors, the country evidence, the research backlog and the guide all work without an account. A signed-in account is needed to create a resident and to record a saved activity.', 'privacy'));
}
function renderStartHere(parent){
 const panel=card('Choose your next step','WELCOME TO NEMOWORLD');panel.classList.add('start-here');
 const paths=[{title:'Meet the world',count:state.ambassadorPage?.catalog?.total?`${state.ambassadorPage.catalog.total} country ambassadors`:'Country ambassadors',text:'Explore ecological districts and meet the country ambassadors. Human moderators oversee the community.',label:'Meet the ambassadors',action:()=>openSection('civic'),icon:'compass'}, {title:'Start with a place',count:state.countries.length?`${state.countries.length} countries & areas`:'Country research context',text:'Choose a country, inspect its dated evidence and find the research questions that need work.',label:'Choose a country',action:()=>openSection('countries'),icon:'earth'}, {title:'Build useful knowledge',count:researchCount(),text:'Proposals become scoped missions with a beneficiary and independent reviewer. Evidence comes before recommendations.',label:'Browse all research',action:()=>browseResearch(),icon:'clipboard-list'}];
 const grid=element('div',null,'start-paths');for(const path of paths){const tile=element('article',null,'start-path'),icon=element('img');icon.src='/assets/icons/'+path.icon+'.svg';icon.alt='';icon.setAttribute('aria-hidden','true');tile.append(icon,element('h3',path.title),paragraph(path.count,'privacy'),paragraph(path.text),button(path.label,path.action,'secondary small'));grid.append(tile);}panel.append(grid,paragraph('Browsing is open to visitors. Create an account to play as a human or bring your AI agents. Proposal counts describe a backlog, not completed studies.','privacy'));parent.append(panel);
 if(state.tab==='world'||state.tab==='help')parent.append(newcomerJourneyCard({compact:true}));
}
function researchCount(){return Number.isInteger(state.research?.catalog_total)?`${state.research.catalog_total.toLocaleString()} research proposals`:'Research proposals';}

function renderWorld(parent) {
  const world = definition(), agent = viewedAgent(), position = worldPosition();if(world.id==='commons'&&!state.gamePresentation)renderStartHere(parent);
  const title=heading(world.name,world.kind==='home'?'A little patch of the world, shaped by its resident and its calling.':world.kind==='house'?'A place to slow down, settle in, and feel at home.':'Follow a path. Find a conversation. See where the world takes you.');title.id='pixel-world-heading';title.classList.add('world-title');const shortcuts=actions(button('Explore worlds',()=>openSection('explore'),'secondary small'));if(selected())shortcuts.append(button('Go home',()=>travelAgent(`home:${state.selected}`),'small'));title.append(shortcuts);parent.append(title);
  const layout = element('div', null, 'world-layout'); const map = element('section', null, 'world-panel');
  const toolbar = element('div', null, 'world-toolbar'); const live = element('strong', `${state.world.paused ? 'Paused · ' : ''}${world.name}`); live.prepend(element('span', null, state.world.paused ? 'live-dot paused' : 'live-dot')); append(toolbar, live, element('span', `${state.world.counts?.world_agents ?? state.world.population ?? state.world.participants.length} characters · ${world.width || world.columns} × ${world.height || world.rows}`, 'muted')); if(state.world.atmosphere) toolbar.append(badge(state.world.atmosphere.label || state.world.atmosphere.phase)); toolbar.append(actions(button('3D world',async()=>{state.graphics='voxel';state.graphicsUnavailable=false;localStorage.setItem('nemoworld-graphics','voxel');await loadWorld();renderView();},state.graphics==='voxel'?'small':'secondary small'),button('Pixel map',async()=>{state.graphics='pixel';localStorage.setItem('nemoworld-graphics','pixel');await loadWorld();renderView();},state.graphics==='pixel'?'small':'secondary small'),button('Focus world',()=>map.requestFullscreen?.(),'secondary small')));map.append(toolbar);
  const canvas = element('canvas'); canvas.id = 'world'; canvas.width = 800; canvas.height = 560; canvas.tabIndex = 0;canvas.classList.toggle('voxel-canvas',state.graphics==='voxel'); canvas.setAttribute('aria-label', state.building ? 'Garden build map. Click a tile to place the selected object. The build form below provides keyboard controls.' : 'Pixel world viewport. Arrow keys or WASD move your selected agent, or pan the view while spectating. World list provides a text alternative.'); if(state.graphics==='voxel'){canvas.setAttribute('aria-label','3D open world. Drag to orbit, click open ground to walk, use WASD or arrow keys to move. The aim line under the view names the tile you are facing; coordinate and movement controls provide a text alternative.');canvas.setAttribute('aria-describedby','world-reticle');}canvas.addEventListener('click', (event) => { if (state.graphics==='voxel'||!state.building) { canvas.focus(); return; } const bounds = canvas.getBoundingClientRect(); const x = state.camera.x + Math.floor((event.clientX - bounds.left) / bounds.width * 20); const y = state.camera.y + Math.floor((event.clientY - bounds.top) / bounds.height * 14); guarded(() => buildAt(x, y)); });
  map.append(canvas);if(agent)map.append(callingHUD());
  // The small interaction prompt and its compact overlay. The prompt is a live region anchored near
  // the aim line and is `pointer-events:none` in the stylesheet, so it never covers the world.
  const promptHost=element('div',null,'game-prompt-host');promptHost.id='game-prompt-host';
  const overlayHost=element('div',null,'game-overlay-host');overlayHost.id='game-overlay-host';
  const guideHost=element('div',null,'game-guide-host');guideHost.id='game-guide-host';
  if(state.gamePresentation)map.append(promptHost,overlayHost,guideHost);
  if(state.graphics==='voxel'){const reticle=element('p',null,'world-reticle');reticle.id='world-reticle';reticle.tabIndex=0;reticle.setAttribute('role','status');reticle.setAttribute('aria-live','polite');reticle.setAttribute('aria-label','Aim line: where the camera looks, what the last pick targets, and which keys walk or turn');reticle.textContent=reticleText({firstPerson:Boolean(agent&&state.firstPerson),facing:state.facing,position,fixture:state.interaction?.fixture||null});map.append(reticle);}
  const lower = element('div', null, 'world-bottom'); const journey = element('div'); const place = worldLandmarks().find((p) => p.x === position.x && p.y === position.y);
  append(journey, paragraph(agent ? `${agent.name} · ${place?.name || world.name}` : `Visiting ${world.name}`, 'eyebrow'), paragraph(place?.description || world.description || (world.kind === 'home' ? 'A personal garden, built and cared for by its agent.' : 'Explore the paths, gathering spaces, and entrances.')), element('small', `${agent ? 'Character' : 'View'} position ${position.x}, ${position.y} · ${agent ? 'Arrow keys / WASD to roam' : 'Arrow keys / WASD to look around'}`));
  const movement = element('div', null, 'movement'); movement.setAttribute('aria-label', agent ? 'Movement controls' : 'Pan view controls'); for (const [direction, icon] of [['up','↑'],['left','←'],['down','↓'],['right','→']]) { const item = button(icon, () => controlStep(direction)); item.setAttribute('aria-label', `${agent ? (state.lookMode ? 'Turn' : 'Move') : 'Look'} ${direction}`); item.disabled = Boolean(agent && (agent.status !== 'active' || state.world.paused)); movement.append(item); } movement.append(viewToggles(agent));
  journey.append(element('div',null,'nearby-portals'));
  if (agent) journey.append(walkToTileForm(agent, world));
  append(lower, journey, movement);map.append(lower);if(state.graphics==='voxel')map.append(actions(button('Look left',()=>queueLook(state.facing.yaw+.35,state.facing.pitch),'secondary small'),button('Look right',()=>queueLook(state.facing.yaw-.35,state.facing.pitch),'secondary small'),button('Zoom in',()=>voxelView?.zoom(-3),'secondary small'),button('Zoom out',()=>voxelView?.zoom(3),'secondary small'),button('Reset camera',()=>{queueLook(.78,state.firstPerson?0:.68);voxelView?.setOrbit({distance:24});},'secondary small')));if(world.kind==='frontier'&&!state.gamePresentation)map.append(frontierHotbar());if(state.graphicsUnavailable)map.append(paragraph('3D graphics are unavailable in this browser. The interactive pixel map remains available.','privacy'));
  const aside = element('aside', null, 'world-aside');aside.tabIndex=-1;if(state.gamePresentation)aside.append(button('Close world tools',()=>setGameDrawer(''),'game-drawer-close'));if(agent)aside.append(callingCard());const inspection=element('div');inspection.id='resident-inspection';aside.append(inspection);if(world.kind==='frontier')aside.append(landCard(),frontierCard());else{const frontier=card('Beyond the Commons','OPEN FRONTIER');frontier.append(paragraph('Explore a finite landscape, steward a plot for a purpose and build with human players and agents.'),button('Enter the frontier',()=>enterFrontier()),button('Explore as a visitor',()=>visitWorld('frontier:0:0'),'secondary small'));aside.append(frontier);} const arrival = card(agent ? (agent.kind==='human'?'Your player':'Your agent') : 'Visiting the world', 'HERE & NOW');
  if (state.agents.length) {
    const controls = element('div'); const select = field(controls, 'agent', 'Character', { options: state.agents.map((a) => ({ value: a.id, label: `${a.name} · ${a.status}` })), value: state.selected }); select.addEventListener('change', () => guarded(() => selectAgent(select.value))); arrival.append(controls);
    if (agent) { const row = element('div', null, 'agent-row'); append(row, agentMark(agent), paragraph(agent.capabilities || 'Ready to explore.')); arrival.append(row); }
    else arrival.append(paragraph('You are looking around as a human visitor. Your character remains in its own location.', 'privacy'), button('Return to my character', async () => { state.viewWorld=''; state.focus=null; await loadWorld(); render(); }, 'secondary small'));
    if (agent) arrival.append(actions(...[['standing','Stand'],['sitting','Sit'],['meditating','Meditate']].map(([posture,label]) => button(label,async()=>{const result=await api(`/agents/${agent.id}/posture`,'POST',{posture});Object.assign(agent,result);await loadWorld();renderView();},'secondary small'))));
    if(agent)disclosure(arrival,'Express yourself',(body)=>body.append(actions(...[['wave','Wave'],['bow','Bow'],['cheer','Cheer'],['think','Thinking'],['heart','Appreciate'],['none','Clear']].map(([emote,label])=>button(label,async()=>{const result=await api('/emotes','POST',{agent_id:agent.id,emote});Object.assign(agent,result.agent||result);await loadWorld();paintWorld();},'secondary small')))));
    arrival.append(actions(button('Resident passport',()=>openSection('passport'),'secondary small'),button('Community',()=>openSection('community'),'secondary small')));
    arrival.append(actions(button('Manage characters →', () => { state.tab = 'characters'; render(); }, 'secondary small')));
    if(state.gamePresentation)arrival.append(button('Choose a character…',()=>openCharacterOverlay(),'secondary small'));
  } else append(arrival, paragraph('Play as yourself, build a home, and explore alongside AI agents. Visitors can look around without an account.', 'muted'), button(state.account ? 'Play as myself' : 'Create account & play', () => state.account?playAsHuman():openAuth('register'), 'small'));
  arrival.append(button('Discover worlds and gardens →', () => openSection('explore'), 'secondary small')); aside.append(arrival);
  if (['home','house'].includes(world.kind) && world.owner_agent_id === selected()?.id) {aside.append(buildCard(world));aside.append(button('Tend crops & craft',()=>openSection('workshop'),'secondary'));}
  if(world.id==='workshop')aside.append(button('Open crafting bench',()=>openSection('workshop'),'secondary'));
  if(world.id==='library')aside.append(button('Write in your journal',()=>openSection('passport'),'secondary'));
  if(['hall','pavilion'].includes(world.id))aside.append(button('Find circles & gatherings',()=>openSection('community'),'secondary'));
  const locations = card('Your place in the world', 'THE BIGGER PICTURE'); const list = element('div', null, 'landmark-list');
  for (const landmark of worldLandmarks()) { const item = button(landmark.name, () => { notice(`${landmark.name}: ${landmark.description || 'Explore this place.'} Position ${landmark.x}, ${landmark.y}.`); }); item.append(element('small', `${landmark.x}, ${landmark.y}`)); list.append(item); }
  for (const portal of worldPortals()) { const item = button(portal.label || portal.name || 'Entrance', () => agent ? enterPortal(portal) : visitWorld(portalTarget(portal))); item.append(element('small', `Entrance · ${portal.x}, ${portal.y}`));list.append(item); }
  const overview=card(null);overview.classList.add('minimap-card');const minimap=element('canvas');minimap.id='world-overview';minimap.width=240;minimap.height=160;minimap.setAttribute('aria-label','Overview of the entire world. The outlined rectangle marks the current map view.');minimap.addEventListener('click',(event)=>{if(viewedAgent())return notice('The outline follows your character. Use movement controls to explore.');const bounds=minimap.getBoundingClientRect(),world=definition(),scale=Math.min(240/world.columns,160/world.rows),offsetX=(240-world.columns*scale)/2,offsetY=(160-world.rows*scale)/2;const px=(event.clientX-bounds.left)/bounds.width*240,py=(event.clientY-bounds.top)/bounds.height*160;state.focus={x:Math.max(0,Math.min(world.columns-1,Math.floor((px-offsetX)/scale))),y:Math.max(0,Math.min(world.rows-1,Math.floor((py-offsetY)/scale)))};guarded(async()=>{await loadWorld();paintWorld();const coordinates=$('.world-bottom small');if(coordinates)coordinates.textContent=`View position ${state.focus.x}, ${state.focus.y} · Arrow keys / WASD to look around`;});});overview.append(minimap,paragraph('Your view of the whole world. Click to look around while visiting.'));if(!state.gamePresentation)locations.append(overview);disclosure(locations,'Places & entrances',(body)=>body.append(list));const mayor=state.world.participants.find(resident=>resident.kind==='npc');if(mayor){const office=card(mayor.name,String(mayor.id).startsWith('amb-')?'COUNTRY AMBASSADOR':'REGIONAL GUIDE');office.append(guidePortrait(mayor),paragraph(mayor.focus),button('Talk to '+mayor.name,()=>talkAmbassador(mayor.id),'small'));aside.append(office);}if(state.gamePresentation){aside.append(interactionCard(),journalCard(),inventoryCard(),projectsCard());map.append(gameConversationHost());}else{aside.append(interactionCard(),chatCard(),journalCard(),inventoryCard(),projectsCard());}aside.append(locations);if(state.gamePresentation){map.append(overview,gameHud(world,agent,position));mountShellTools(map,canvas,world,agent,position);}append(layout, map, aside); parent.append(layout);renderResidentInspection(); paintWorld();
  if(!state.interaction&&viewedAgent())queueMicrotask(()=>guarded(()=>loadInteraction({})));
}
// The one next action the HUD shows: the resident's current calling objective, else the quest's next
// step, else nothing at all. It is one line, never a list, and never a count.
function nextActionLine(){
  const objective=state.callings?.current_objective?.title;
  if(typeof objective==='string'&&objective.trim())return objective;
  const step=state.quests?.next_action?.step_title;
  if(typeof step==='string'&&step.trim())return step;
  const title=state.quests?.next_action?.title;
  return typeof title==='string'&&title.trim()?title:null;
}
function gameHud(world,agent,position){
  const hud=element('div',null,'game-hud');hud.id='game-hud';
  const top=element('div',null,'game-hud-top'),place=element('div',null,'game-place');
  const pos=element('span','Tile ','game-position');const coords=element('span',`${position.x}, ${position.y}`);coords.id='game-coordinates';pos.append(coords);
  const frontier=state.world.frontier;
  const extent=world.kind==='frontier'&&frontier?.land_world
    ? `Area ${frontier.sector_x}, ${frontier.sector_y} · ${frontier.land_world.width_m} × ${frontier.land_world.height_m} m fixed world`
    : `${world.width||world.columns} × ${world.height||world.rows} tiles`;
  append(place,paragraph(state.world.paused?'WORLD PAUSED':!agent||state.gameMode==='observe'?'LOOKING AROUND':'LIVE WORLD','game-kicker'),element('strong',world.name),pos,element('span',extent,'game-extent'));
  const count=element('span',String(state.world.counts?.world_agents??state.world.population??state.world.participants.length));count.id='game-population';
  top.append(place,append(element('div',null,'game-live-count'),count,element('span',' residents here')));hud.append(top);
  const bottom=element('div',null,'game-hud-bottom');
  // H4 appears only when the server returned an objective or a next step, so an empty line is never
  // invented. Its wording is the server's own title.
  const next=nextActionLine();
  if(next){const line=element('p',next,'game-next');line.id='game-next-action';bottom.append(line);}
  // H5 and the control hint print the keys that actually act: Enter, Space or I. `E` turns the camera.
  const hint=element('p',controlHint({playing:Boolean(agent&&state.gameMode!=='observe'),mode:state.firstPerson?'first-person':'third-person'}),'game-control-hint');hint.id='game-control-hint';
  const actionsRow=element('div',null,'game-quickbar');actionsRow.setAttribute('role','group');actionsRow.setAttribute('aria-label','World actions');
  const interact=button('Interact',()=>usePickedFixture(),'game-quick');interact.id='game-interact-button';interact.disabled=!agent||!state.interaction?.fixture;
  const build=button(state.building?'Finish building':'Build',()=>{
    // Observing is read-only, and the refusal says so rather than opening a door that cannot work.
    if(state.gameMode==='observe')return notice('Observing is read-only. Play as a resident to build.');
    if(!agent)return state.account?playAsHuman():openAuth('register');
    if(world.kind==='frontier'){state.building=!state.building;renderView();return;}
    if(['home','house'].includes(world.kind)){setGameDrawer('tools');$('#home-build-card')?.scrollIntoView({block:'nearest'});return;}
    return enterFrontier();
  },'game-quick');build.id='game-build-button';
  const chat=button('Chat',()=>setGameDrawer('chat'),'game-quick');const places=button('Places',()=>openSection('explore'),'game-quick');const tools=button('More',()=>setGameDrawer('tools'),'game-quick');
  actionsRow.append(interact,build,chat,places,tools);bottom.append(hint,actionsRow);hud.append(bottom);
  const fixture=state.interaction?.fixture;
  const target=element('p',fixture?`${fixture.action?.label||fixture.label} · ${fixture.x}, ${fixture.y} · ${INTERACTION_KEY_LABEL} to interact`:targetHint(null),'game-target');target.id='game-target';hud.append(target);
  // One line of input feedback: the accepted step, the refusal and its reason, or a reconcile after a
  // refusal. It is the same wording the movement path produced, so it can never describe a step the
  // server did not take, and it is a polite live region so it is announced, not only drawn. It floats
  // just above the control band so it reads with the controls without pushing the band into the pad.
  hud.append(moveFeedbackElement());
  // The travel affordance: the entrances the server published for this world, the way back first.
  hud.append(travelPanel(world,agent,position));
  // The observer's own honest connection line, and the refusal when a read was refused.
  if(state.gameMode==='observe'&&spectator){
    const line=element('p',null,'game-observer');line.id='game-observer-status';
    const refusal=spectator.lastRefusal();
    if(refusal){line.setAttribute('role','alert');line.textContent=`${refusal.message} ${refusal.next_step||''}`.trim();}
    else {line.setAttribute('role','status');line.textContent=spectator.status().detail;}
    hud.append(line);
  }
  return hud;
}
/** The HUD's one line of input feedback, built from the outcome the movement path last produced. */
function moveFeedbackElement(){
  const feedback=state.moveFeedback;
  const line=element('p',feedback?.text||'',feedback?`game-feedback game-feedback-${feedback.tone}`:'game-feedback');
  line.id='game-move-feedback';line.setAttribute('role','status');line.setAttribute('aria-live','polite');
  line.hidden=!feedback;return line;
}
/** Remember and show the result of one movement attempt. A refusal stays until the next step. */
function reportMoveOutcome(feedback){state.moveFeedback=feedback||null;syncMoveFeedback();}
function syncMoveFeedback(){
  const line=$('#game-move-feedback');if(!line)return;
  const feedback=state.moveFeedback;
  line.hidden=!feedback;
  line.textContent=feedback?.text||'';
  line.className=feedback?`game-feedback game-feedback-${feedback.tone}`:'game-feedback';
}
/** The doors we can actually see: the entrances the server published, the way back sorted first. */
function travelPanel(world,agent,position){
  const routes=travelRoutes(worldPortals(),position,{limit:3,home:agent?`home:${agent.id}`:null});
  const node=element('div',null,'game-travel');node.id='game-travel';
  node.dataset.signature=routes.map(route=>`${route.id}:${route.distance}:${route.back}`).join('|');
  if(!routes.length){node.hidden=true;return node;}
  node.setAttribute('role','group');node.setAttribute('aria-label','Entrances from here');
  node.append(paragraph('WAYS OUT','game-travel-kicker'));
  for(const route of routes){
    const item=button(route.label,()=>enterPortal(route.portal),`game-travel-route${route.back?' game-travel-back':''}`);
    item.dataset.portal=route.id;
    item.setAttribute('aria-label',routeHint(route));
    item.append(element('small',route.back?'the way back':`${route.distance} tile${route.distance===1?'':'s'} away`));
    item.disabled=Boolean(world.paused)||Boolean(agent&&agent.status!=='active');
    node.append(item);
  }
  return node;
}
/** Rebuild the travel list only when the routes themselves change, so a tween never thrashes the DOM. */
function syncTravelPanel(){
  const node=$('#game-travel');if(!node)return;
  const agent=viewedAgent(),world=definition(),position=worldPosition();
  const routes=travelRoutes(worldPortals(),position,{limit:3,home:agent?`home:${agent.id}`:null});
  const signature=routes.map(route=>`${route.id}:${route.distance}:${route.back}`).join('|');
  if(node.dataset.signature===signature)return;
  node.replaceWith(travelPanel(world,agent,position));
}
function buildCard(world) {
  const node = card(world.kind==='house'?'Furnish your cottage':'Shape your garden', 'YOUR OWN SPACE');node.id='home-build-card'; node.append(paragraph(world.kind==='house'?'Make room for reading, gathering, and quiet reflection. The arrival area and permanent furniture stay clear.':'Plant a garden, make paths, build gathering places, and welcome visitors.', 'muted'));
  if(![...(state.world.build_palette||[]),'remove'].includes(state.buildKind))state.buildKind='flowers';const ownAgentHere = viewedAgent()?.id === world.owner_agent_id;
  const toggle = button(state.building ? 'Finish building' : 'Start building', () => { if (!ownAgentHere) return notice('Go home with this character to build.'); state.building = !state.building; renderView(); }, 'small'); toggle.disabled = !ownAgentHere; node.append(toggle);
  if (state.building) {
    const controls = element('div'); const palette = field(controls, 'kind', 'Object palette', { options: [...(state.world.build_palette || ['flowers','tree','farm','path','bench','cottage','pond','lamp','fountain']).map(item=> typeof item==='string'?{value:item,label:item==='farm'?'Crop patch':item.replaceAll('_',' ')}:{value:item.type||item.kind||item.id,label:item.label||item.name||item.type}),{value:'remove',label:'Remove object'}], value:state.buildKind }); palette.addEventListener('change', () => {state.buildKind=palette.value;}); node.append(controls,paragraph('Click a tile on the map, or use coordinates below. Your character and entrance need room to move.', 'privacy'));
    const inputs = form(node, 'Apply at tile', async (data) => buildAt(Number(data.x), Number(data.y))); field(inputs,'x','Tile X',{type:'number',min:0,max:(world.width||world.columns)-1,value:Math.min((world.width||world.columns)-1,worldPosition().x+2)});field(inputs,'y','Tile Y',{type:'number',min:0,max:(world.height||world.rows)-1,value:worldPosition().y});
  }
  if(world.kind==='home')disclosure(node, 'Garden name & visitors', (body) => { const controls = form(body,'Save garden settings',async(data)=>{await api(`/agents/${world.owner_agent_id}/home`,'PATCH',data);await refresh();render();notice('Garden settings saved.');});field(controls,'name','Garden name',{max:80,value:world.name,full:true});field(controls,'visibility','Who can visit?',{options:[{value:'public',label:'Everyone can visit'},{value:'private',label:'Only my account and resident'}],value:world.visibility||'public',full:true}); });return node;
}
async function playAsHuman(){
 if(!state.account){openAuth('register');return;}let player=state.agents.find(agent=>agent.kind==='human');
 if(!player){player=await api('/agents','POST',{kind:'human',name:state.account.name,region_id:'commons',capabilities:'Human player',limitations:'Controlled by its signed-in human',color:'#3d5875',symbol:'◆'});await refresh();}
 if(player.status!=='active'){await openSection('characters');notice('Resume your human player before entering the world.');return;}
 await selectAgent(player.id);setFirstPerson(true);state.tab='world';
 // Save the initial inward look once. A returning player keeps the facing they last chose.
 const avatar=selected();
 if(currentWorldId()==='commons'&&avatar?.x===10&&avatar?.y===6&&avatar?.last_look===0)queueLook(-3*Math.PI/4,-.08,{apply:false});
 render();notice('You are playing as '+player.name+'. Use WASD, arrow keys or tap the ground to walk.');
}
async function enterFrontier(hops=0,expectedId=selected()?.id){
 if(hops>4||expectedId&&selected()?.id!==expectedId)return;
 if(!state.account)return visitWorld('frontier:0:0');if(!selected())await playAsHuman();if(!selected())return;
 state.viewWorld='';state.focus=null;state.building=false;await loadWorld();
 if(definition().kind==='frontier'){state.tab='world';render();return;}
 let portal=worldPortals().find(item=>portalTarget(item)==='frontier:0:0');
 if(!portal){if(definition().kind==='home'){await travelAgent('commons');return enterFrontier(hops+1,expectedId);}portal=worldPortals().find(item=>portalTarget(item)==='commons'||portalTarget(item)===`home:${selected().id}`);if(!portal)return notice('Return to the Commons through this world’s exit, then enter the frontier.');if(!await walkTo(portal.x,portal.y))return;await travelAgent(portalTarget(portal));return enterFrontier(hops+1,expectedId);}
 state.tab='world';render();if(await walkTo(portal.x,portal.y))await travelAgent('frontier:0:0');
}
// The keyboard and text-mode way to move: type the tile, and the same planner the click path uses
// walks the resident there one checked step at a time. It is the documented fallback for a viewer who
// cannot drag in the 3D world, and the pixel map and the World list remain readable alternatives.
function walkToTileForm(agent, world) {
  const node = element('div', null, 'walk-to-tile');
  node.append(paragraph(`Walk to a tile with typed coordinates. The planner uses the same saved world, one grid step at a time.`, 'privacy'));
  const inputs = form(node, 'Walk to tile', async values => {
    const x = Number(values.x), y = Number(values.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Enter whole tile coordinates.');
    if (x < 0 || y < 0 || x >= (world.width || world.columns) || y >= (world.height || world.rows)) throw new Error('That tile is outside this world.');
    if (await walkTo(x, y)) notice(`Walked to ${x}, ${y}.`);
  });
  field(inputs, 'x', 'Tile X', { type: 'number', min: 0, max: (world.width || world.columns) - 1, value: agent.x });
  field(inputs, 'y', 'Tile Y', { type: 'number', min: 0, max: (world.height || world.rows) - 1, value: agent.y });
  return node;
}
async function walkTo(x,y){
 const player=viewedAgent();if(!player)return false;const worldId=player.world_id,id=player.id,epoch=state.sessionEpoch||0;
 const route=planWalk(getWorldDefinition(worldId),player,{x,y},{objects:state.world.objects||[],blocks:state.world.blocks||[]});if(!route){notice('No known walkable route to that tile. Choose nearby open ground.');return false;}
 const version=++walkVersion;walkActive=true;try{for(const direction of route){if(version!==walkVersion||epoch!==(state.sessionEpoch||0)||selected()?.id!==id||selected().world_id!==worldId)return false;const before={x:selected().x,y:selected().y};for(let attempt=0;attempt<4;attempt++){try{await moveAgent(direction,true);break;}catch(error){if(error.status!==429||attempt===3)throw error;await new Promise(resolve=>setTimeout(resolve,250*(attempt+1)));if(version!==walkVersion||epoch!==(state.sessionEpoch||0))return false;}}if(selected()?.id!==id||selected().x===before.x&&selected().y===before.y){notice('The path is blocked. Choose another route.');return false;}}
 return true;}finally{walkActive=false;}
}
async function pickWorld(pick){
 if(state.tab!=='world')return;state.voxelSelection={x:pick.x,y:pick.y,z:pick.z||0};notifyPick(state.voxelSelection);if(state.world.frontier?.parcels){state.parcelSelection=state.world.frontier.parcels.find(plot=>pick.x>=plot.x&&pick.x<plot.x+plot.width&&pick.y>=plot.y&&pick.y<plot.y+plot.height)||null;updatePlotPanel();}
 if(state.building){const point=state.buildKind==='remove'?pick:pick.adjacent||pick;await buildAt(point.x,point.y,point.z||0,pick);return;}
 // Selecting a tile reads what it offers from the server, so the interaction panel always shows the
 // same fixture, requirement and next step the server would enforce.
 const readTile=async()=>{state.interactionRefusal=null;await guarded(()=>loadInteraction({x:pick.x,y:pick.y})).catch(()=>{});};
 if(pick.type==='participant'){state.inspectedResident=pick.participant;renderResidentInspection();await readTile();if(state.gamePresentation){state.gameDrawer='tools';applyGameShell();$('#resident-inspection')?.scrollIntoView({block:'nearest'});}paintWorld();return;}
 if(!viewedAgent()){if(pick.portal?.target_world_id||pick.portal?.targetWorldId)return visitWorld(portalTarget(pick.portal));state.focus={x:pick.x,y:pick.y};await loadWorld();await readTile();paintWorld();return;}
 if(pick.type==='block'){notice(`Block ${pick.block?.type||''} · ${pick.x}, ${pick.y}, height ${pick.z}. Enable building to place beside it or remove your own block.`);await readTile();paintWorld();return;}
 await readTile();
 if(pick.portal){await enterPortal(pick.portal);return;}
 if(await walkTo(pick.x,pick.y)&&pick.type==='gate')notice('You reached a frontier gate. Use the expansion controls to open the neighboring area.');
}
function syncWorldControls(){
 const player=viewedAgent(),position=worldPosition();
 // The aim line and the position readout follow the tile the avatar is *drawn* at, which is on the
 // segment between the last two confirmed tiles, so a mid-step the view matches what the player sees.
 // Everything the server itself decides (portal adjacency, gate range) still reads the stored tile.
 const drawn=player?tileOf(displayed(player,performance.now())):position;
 const coordinates=$('.world-bottom small');if(coordinates)coordinates.textContent=`${player?'Player':'View'} position ${drawn.x}, ${drawn.y}${player&&drawn.z>0?`, layer ${drawn.z}`:''} · ${state.graphics==='voxel'?(state.firstPerson?'First person · drag to look · WASD relative to view':'Drag to orbit · click ground to walk'):'Arrow keys / WASD'}`;
 const reticle=$('#world-reticle');if(reticle){const pick=state.voxelSelection,world=definition();reticle.textContent=reticleText({firstPerson:Boolean(player&&state.firstPerson),facing:state.facing,position:drawn,selection:pick,blocked:pick?!(walkable(pick,world)&&!solidSceneryAt(pick,state.world.objects||[])):null,fixture:state.interaction?.fixture||null});}
 const nearby=$('.nearby-portals');if(nearby){nearby.replaceChildren();if(player)for(const portal of worldPortals().filter(p=>Math.abs(p.x-position.x)+Math.abs(p.y-position.y)<=1))nearby.append(button(portalLabel(portal),()=>enterPortal(portal),'small'));}
 for(const node of document.querySelectorAll('[data-frontier-expand]')){const gate=state.world.frontier?.neighbors.find(item=>item.direction===node.dataset.frontierExpand);node.disabled=!player||player.status!=='active'||state.world.paused||!gate||gate.exists||Math.abs(player.x-gate.x)+Math.abs(player.y-gate.y)>2;}
 const climb=$('[data-climb]');if(climb)climb.disabled=!player||player.status!=='active'||state.world.paused||!climbDirection();
 const tally=$('.frontier-block-tally');if(tally)tally.textContent=`${state.world.frontier?.block_count??state.world.blocks?.length??0} blocks in this area`;
 // H4 and the observer's own status line follow the same refresh the rest of the HUD does.
 syncGameHud();
}
function lookToggle(agent){
 const item=button('Turn mode',()=>{state.lookMode=!state.lookMode;renderView();},'secondary small');
 item.setAttribute('aria-pressed',String(state.lookMode));item.setAttribute('aria-label','Turn the character instead of walking');
 item.disabled=!agent||agent.status!=='active'||state.world.paused;return item;
}
function climbToggle(agent){
 const item=button('Step-up mode',()=>{state.climbing=!state.climbing;renderView();},'secondary small');
 item.setAttribute('aria-pressed',String(state.climbing));item.setAttribute('aria-label','Climb one block layer with the movement controls');
 item.disabled=!agent||agent.status!=='active'||state.world.paused;return item;
}
function firstPersonToggle(agent){
 const item=button('First person',()=>toggleFirstPerson(),'secondary small');
 item.setAttribute('aria-pressed',String(state.firstPerson));item.setAttribute('aria-label','First person camera that follows your resident');
 item.disabled=!agent||agent.status!=='active'||state.world.paused;return item;
}
function viewToggles(agent){return actions(lookToggle(agent),climbToggle(agent),firstPersonToggle(agent));}
function frontierHotbar(){
 const row=element('div',null,'frontier-hotbar');row.setAttribute('aria-label','Block building tools');
 const palette=state.world.frontier?.palette||[];if(![...palette,'remove'].includes(state.buildKind))state.buildKind='wood';
 row.append(button(state.building?'Finish building':'Build blocks',()=>{if(!viewedAgent())return state.account?playAsHuman():openAuth('register');state.building=!state.building;renderView();},'small'));
 palette.forEach((type,index)=>{const item=button(`${index+1} ${type}`,()=>{state.buildKind=type;state.building=true;renderView();},'secondary small block-tool block-'+type);item.setAttribute('aria-pressed',String(state.building&&state.buildKind===type));item.disabled=!viewedAgent()||viewedAgent().status!=='active'||state.world.paused;row.append(item);});
 const remove=button('Remove my block',()=>{state.buildKind='remove';state.building=true;renderView();},'secondary small');remove.setAttribute('aria-pressed',String(state.building&&state.buildKind==='remove'));remove.disabled=!viewedAgent()||viewedAgent().status!=='active'||state.world.paused;row.append(remove);
 const climb=button('Climb to previewed block',()=>climbPreview(),'secondary small');climb.dataset.climb='preview';climb.setAttribute('aria-label','Climb one block layer onto the previewed neighbouring tile');climb.disabled=!viewedAgent()||viewedAgent().status!=='active'||state.world.paused||!climbDirection();row.append(climb);return row;
}
function selectPlot(plot){state.parcelSelection=plot;updatePlotPanel();paintWorld();}
function landCard(){
 const node=card('A place with a purpose','LAND & STEWARDSHIP');node.classList.add('land-card');
 node.append(paragraph('48 × 48 m area · 64 plots · Each plot is 6 × 6 m in this virtual world.','privacy'));
 const grid=element('div',null,'plot-grid');grid.setAttribute('aria-label','64 plots in this area');
 for(const plot of state.world.frontier.parcels||[]){const control=button(`${plot.plot_x+1}.${plot.plot_y+1}`,()=>selectPlot(plot),'plot-cell plot-'+plot.state);control.dataset.plotId=plot.id;control.setAttribute('aria-label',`Plot ${plot.plot_x+1}, ${plot.plot_y+1} · ${plot.state}${plot.purpose?' · '+plot.purpose:''}`);control.setAttribute('aria-pressed',String(state.parcelSelection?.id===plot.id));grid.append(control);}
 node.append(grid,paragraph('Gold: available · Teal: stewarded · Muted: public or conserved land','plot-legend privacy'));
 const detail=element('div');detail.id='plot-detail';node.append(detail);queueMicrotask(updatePlotPanel);return node;
}
function updatePlotPanel(){
 const detail=$('#plot-detail');if(!detail)return;
 const parcels=state.world.frontier?.parcels||[];let plot=parcels.find(item=>item.id===state.parcelSelection?.id);
 if(!plot)plot=parcels.find(item=>item.is_mine)||parcels.find(item=>item.state==='available')||parcels[0];
 state.parcelSelection=plot||null;detail.replaceChildren();if(!plot)return;
 for(const node of document.querySelectorAll('[data-plot-id]'))node.setAttribute('aria-pressed',String(node.dataset.plotId===plot.id));
 detail.append(element('h3',`Plot ${plot.plot_x+1}.${plot.plot_y+1}`),paragraph(plot.id,'plot-address'),badge(plot.state),paragraph(`6 × 6 m · 36 m² virtual footprint · ${plot.buildable_cells} usable ground cells`,'privacy'));
 if(plot.reserved_reason)detail.append(paragraph(plot.reserved_reason));
 if(plot.purpose)detail.append(element('strong',plot.purpose),paragraph(plot.description||''),paragraph(`Steward: ${plot.steward_name||'Resident'}`,'privacy'));
 const player=viewedAgent();if(player)detail.append(button('Walk to plot',async()=>{const def=definition();let best=null;for(let y=plot.y;y<plot.y+plot.height;y++)for(let x=plot.x;x<plot.x+plot.width;x++){const route=planWalk(def,player,{x,y},{objects:state.world.objects||[],blocks:state.world.blocks||[]});if(route&&(!best||route.length<best.length))best={x,y,length:route.length};}if(!best)return notice('No clear route into this plot.');await walkTo(best.x,best.y);},'secondary small'));
 if(plot.state==='available'){
  if(state.account&&state.world.frontier?.my_plot){const mine=state.world.frontier.my_plot;detail.append(paragraph(`You already steward ${mine.address}. Remove its construction and release it before choosing another plot.`,'privacy'),button('View my plot',()=>visitWorld(mine.world_id),'secondary small'));}
  else if(state.account){const controls=form(detail,'Steward this plot',async input=>{await api('/land/assign','POST',{plot_id:plot.id,purpose:input.purpose,description:input.description});await loadWorld();renderView();notice('Plot stewardship saved. Your human player and authorized agents can now build here.');});field(controls,'purpose','What will this place do?',{max:120,full:true,hint:'Public purpose: agriculture learning garden, climate research desk, or community workshop.'});field(controls,'description','Public project description',{required:false,type:'textarea',max:500,full:true});}
  else detail.append(button('Create account to steward a plot',()=>openAuth('register')));
 }
 if(plot.is_mine)detail.append(button('Release empty plot',async()=>{await api('/land/release','POST',{plot_id:plot.id});await loadWorld();renderView();notice('The empty plot is available to another resident.');},'secondary small'));
 if(plot.state==='assigned')detail.append(actions(button('Find useful work',()=>browseResearch(),'secondary small'),button('Community projects',()=>openSection('community'),'secondary small')));
 detail.append(paragraph('One plot per adult account during this stage. Stewardship is free; plot sales and transfers are not enabled.','privacy'));
}
function renderLandAtlas(parent){
 const data=state.landData;if(!data)return;const panel=card('Every place has an address','FINITE WORLD');
 panel.append(paragraph('768 × 768 m · 589,824 m² of virtual ground · 256 areas · 16,384 plotted addresses. Roads and conservation plots are reserved.'));
 const counts=data.counts||{};panel.append(paragraph(`${counts.assigned??0} stewarded · ${counts.available??0} available in opened areas · ${(counts.reserved??0).toLocaleString()} permanently reserved${counts.blocked_by_existing?' · '+counts.blocked_by_existing+' awaiting construction cleanup':''}`,'privacy'));
 const grid=element('div',null,'land-atlas');grid.setAttribute('aria-label','The fixed 16 by 16 area map');
 for(const area of data.areas||[]){const control=button(`${area.sector_x},${area.sector_y}`,async()=>{if(area.opened)return visitWorld(area.world_id);notice(`Area ${area.sector_x}, ${area.sector_y} is part of the fixed map. Reach its neighboring passage to open it.`);},'land-area'+(area.opened?' opened':''));control.setAttribute('aria-label',`Area ${area.sector_x}, ${area.sector_y} · ${area.opened?'open':'unopened'}`);grid.append(control);}
 const atlasScroll=element('div',null,'land-atlas-scroll');atlasScroll.tabIndex=0;atlasScroll.setAttribute('role','region');atlasScroll.setAttribute('aria-label','Fixed world map; scroll horizontally on narrow screens');atlasScroll.append(grid);panel.append(atlasScroll,paragraph('Opening an area reveals land already in the registry. It does not create additional land. Purpose, steward and building history stay attached to each plot.','privacy'));parent.append(panel);
}
function frontierCard(){
 const expectedWorld=state.world.world.id,data=state.world.frontier,node=card('Build the frontier','SHARED OPEN WORLD');node.classList.add('frontier-tools');
 node.append(paragraph(`Area ${data.sector_x}, ${data.sector_y} · Humans and agents build together.`),paragraph(`${data.block_count||0} blocks in this area`,'frontier-block-tally privacy'));
 if(!viewedAgent())node.append(button(state.account?'Play as myself':'Create account & play',()=>state.account?playAsHuman():openAuth('register')));
 else{node.append(paragraph('Steward a plot above, then choose a block and click a face or use coordinates. Stack up to eight layers inside your plot. Roads and conservation land stay clear.','privacy'));
 const controls=form(node,'Apply block at coordinates',async data=>buildAt(Number(data.x),Number(data.y),Number(data.z)));const mine=data.my_plot?.world_id===expectedWorld?data.my_plot:null;field(controls,'x','Block X',{type:'number',min:0,max:47,value:mine?mine.x+1:Math.min(47,worldPosition().x+2)});field(controls,'y','Block Y',{type:'number',min:0,max:47,value:mine?mine.y+1:Math.min(47,worldPosition().y+2)});field(controls,'z','Block height',{type:'number',min:0,max:7,value:0,full:true});}
 node.append(blueprintCard(data,expectedWorld),plotCollaborationCard(data,expectedWorld));
 const gates=element('div',null,'frontier-gates');for(const gate of data.neighbors){const direction={up:'North',down:'South',left:'West',right:'East'}[gate.direction];const row=element('div',null,'frontier-gate');row.append(element('strong',direction),paragraph(gate.exists?'Neighboring area is open':'New area available','privacy'));
 row.append(button(viewedAgent()?'Walk to gate':'Look at gate',async()=>{if(viewedAgent())await walkTo(gate.x,gate.y);else{state.focus={x:gate.x,y:gate.y};await loadWorld();paintWorld();}},'secondary small'));
 if(gate.exists&&viewedAgent())row.append(button('Enter '+direction.toLowerCase()+' area',()=>enterPortal({x:gate.x,y:gate.y,target_world_id:gate.target_world_id}),'small'));
 if(gate.exists&&!viewedAgent())row.append(button('Explore area',()=>visitWorld(gate.target_world_id),'secondary small'));
 if(!gate.exists){const expand=button('Open '+direction.toLowerCase()+' area',async()=>{const result=await api('/frontier/expand','POST',{agent_id:state.selected,world_id:expectedWorld,direction:gate.direction});await loadWorld();renderView();notice(result.created?'New area opened. Use its entrance to walk there.':'This neighboring area is already open. Use its entrance to walk there.');},'small');expand.dataset.frontierExpand=gate.direction;row.append(expand);}gates.append(row);
 }node.append(gates);disclosure(node,'Shared building limits',body=>{body.append(paragraph(`Each operator can open up to ${data.limits.expansions_per_operator_day} new areas per UTC day. The fixed map contains ${data.limits.sectors} areas and ${data.limits.blocks_per_sector} blocks per area. Build within ${data.limits.build_range} tiles of your player. Expansion and building earn no contribution coins.`,'privacy'));});return node;
}
/**
 * Reusable construction blueprints. The panel previews the exact cells, layers, block count,
 * doorways and ownership the server computed, then applies the same plan. Every value the server
 * returns is written as text, so a blueprint can never introduce markup into the page.
 */
function blueprintCard(data,expectedWorld){
 const node=card('Small construction blueprints','REUSABLE BUILDINGS');node.classList.add('blueprint-card');
 const catalogue=data?.blueprints||[];if(!catalogue.length)return node;
 const player=viewedAgent(),disabled=!player||player.status!=='active'||state.world.paused;
 const current=catalogue.some(item=>item.id===state.blueprint)?state.blueprint:catalogue[0].id;
 node.append(paragraph('Preview an original small building inside your own plot, then apply it. Application is all or nothing: if one cell or layer fails a server rule, nothing is built.','privacy'));
 const controls=element('div',null,'field-grid');
 const choose=field(controls,'blueprint','Blueprint',{options:catalogue.map(item=>({value:item.id,label:`${item.name} · ${item.block_count} blocks`})),value:current});
 choose.setAttribute('aria-label','Choose a construction blueprint to preview');
 choose.addEventListener('change',()=>{state.blueprint=choose.value;state.blueprintReport=null;renderView();});
 const mine=data.my_plot?.world_id===expectedWorld?data.my_plot:null;
 const anchor=state.blueprintAnchor||{x:mine?mine.x+1:Math.min(47,worldPosition().x+1),y:mine?mine.y+1:Math.min(47,worldPosition().y+1)};
 const anchorX=field(controls,'blueprint_x','Blueprint X',{type:'number',min:0,max:47,value:String(anchor.x)});
 const anchorY=field(controls,'blueprint_y','Blueprint Y',{type:'number',min:0,max:47,value:String(anchor.y)});
 anchorX.addEventListener('change',()=>{state.blueprintAnchor={x:Number(anchorX.value),y:Number(anchorY.value)};});
 anchorY.addEventListener('change',()=>{state.blueprintAnchor={x:Number(anchorX.value),y:Number(anchorY.value)};});
 const readAnchor=()=>(state.blueprintAnchor={x:Number(anchorX.value),y:Number(anchorY.value)});
 node.append(controls);
 const preview=button('Preview blueprint',async()=>{
  if(!player)return state.account?playAsHuman():openAuth('register');
  state.blueprint=choose.value;
  const tile=readAnchor();
  state.blueprintReport=await api('/frontier/build','POST',{agent_id:player.id,world_id:expectedWorld,blueprint:choose.value,x:tile.x,y:tile.y,preview:true});
  renderView();
 },'small');
 preview.dataset.blueprintPreview='1';preview.setAttribute('aria-label','Preview the chosen blueprint footprint without building it');
 const apply=button('Apply blueprint',async()=>{
  if(!player)return state.account?playAsHuman():openAuth('register');
  const tile=readAnchor();
  const result=await api('/frontier/build','POST',{agent_id:player.id,world_id:expectedWorld,blueprint:choose.value,x:tile.x,y:tile.y});
  state.blueprint=result.blueprint.id;state.blueprintReport=null;
  await loadWorld();paintWorld();
  notice(result.replay?`${result.blueprint.name} is already built at ${tile.x}, ${tile.y}; nothing changed.`:`${result.blueprint.name} built at ${tile.x}, ${tile.y} with ${result.new_blocks} blocks and ${result.actions} building actions.`);
  renderView();
 },'small');
 apply.dataset.blueprintApply='1';apply.setAttribute('aria-label','Apply the chosen blueprint to the previewed position');
 const remove=button('Remove this structure',async()=>{
  if(!player)return state.account?playAsHuman():openAuth('register');
  const tile=readAnchor();
  const result=await api('/frontier/build','POST',{agent_id:player.id,world_id:expectedWorld,blueprint:choose.value,x:tile.x,y:tile.y,remove:true});
  state.blueprintReport=null;
  await loadWorld();paintWorld();
  notice(result.replay?`Nothing of ${result.blueprint.name} stands at ${tile.x}, ${tile.y}.`:`Removed ${result.removed_blocks} blocks of ${result.blueprint.name}. Anyone standing on it was lowered to the ground.`);
  renderView();
 },'secondary small');
 remove.dataset.blueprintRemove='1';remove.setAttribute('aria-label','Remove the structure at the previewed position in your plot');
 for(const control of [preview,apply,remove])control.disabled=disabled;
 node.append(actions(preview,apply,remove));
 if(disabled)node.append(paragraph(player?'Your character is paused; blueprints stay disabled until it is active again.':'Play as your character to preview and build a blueprint.','privacy'));
 node.append(blueprintReportView(state.blueprintReport));
 return node;
}
/**
 * Plot collaboration. A steward's human operator invites one specific operator or resident to build
 * on this plot for a stated purpose, a stated duration and a deliberately narrow scope, previews the
 * exact access, then confirms, lists or revokes it. A guest reads what it may do here and elsewhere.
 * The preview is a read and writes nothing. Every value the server returns is written as text, so a
 * grant can never introduce markup into the page.
 */
function grantCheckboxes(parent,name,legendText,options){
 const group=element('fieldset',null,'choice-group');group.append(element('legend',legendText));
 for(const option of options){const label=element('label',null,'choice');const box=element('input');box.type='checkbox';box.name=name;box.value=String(option.value);box.checked=Boolean(option.checked);box.setAttribute('aria-label',`${legendText}: ${option.label}`);label.append(box,element('span',option.label));group.append(label);}
 parent.append(group);return group;
}
function grantFormValues(formNode){
 const values=Object.fromEntries(new FormData(formNode));
 const guest=String(values.grant_agent_id||'').trim()||String(values.guest_agent_id||'').trim();
 const payload={plot_id:values.plot_id,purpose:values.purpose,duration_minutes:Number(values.duration_minutes),block_types:[...formNode.querySelectorAll('input[name="block_types"]:checked')].map(box=>box.value),layers:[...formNode.querySelectorAll('input[name="layers"]:checked')].map(box=>Number(box.value)),actions:[...formNode.querySelectorAll('input[name="actions"]:checked')].map(box=>box.value),max_blocks:Number(values.max_blocks)};
 if(guest)payload.guest_agent_id=guest;
 return payload;
}
function grantRows(title,grants,emptyText,line){
 const node=element('div',null,'grant-list');node.append(element('h3',title));
 if(!grants.length){node.append(paragraph(emptyText,'privacy'));return node;}
 for(const grant of grants){
  const row=element('article',null,'grant-row');
  row.append(element('strong',line(grant)),badge(grant.status));
  row.append(paragraph(`${grant.purpose} · ${grant.permissions}`,'privacy'));
  row.append(paragraph(`${grant.live?'Live':'Not usable'} · from ${grant.steward_name} to ${grant.guest_name} · ${grant.used_blocks} of ${grant.scope?grant.scope.max_blocks:'—'} allowed blocks standing · recorded use ${grant.uses} · expires ${date(grant.expires_at)}${grant.revoked_at?` · revoked ${date(grant.revoked_at)}`:''}.`,'privacy'));
  if(grant.can_revoke){
   const revoke=button('Revoke this access',async()=>{await api('/frontier/grant/revoke','POST',{grant_id:grant.id});state.grantPreview=null;await loadWorld();renderView();notice(`Collaboration revoked for ${grant.guest_name}. Their next build here is refused immediately.`);},'secondary small');
   revoke.dataset.grantRevoke=grant.id;revoke.setAttribute('aria-label',`Revoke the collaboration granted to ${grant.guest_name}`);
   row.append(revoke);
  }
  node.append(row);
 }
 return node;
}
function grantReportView(report){
 const node=element('div',null,'grant-report');node.id='grant-report';node.tabIndex=0;
 node.setAttribute('role','status');node.setAttribute('aria-live','polite');
 node.setAttribute('aria-label','Collaboration preview: plot, guest, purpose, scope, duration and expiry');
 if(!report){node.append(paragraph('Preview the exact access before you confirm it. A preview reads storage and writes nothing.','privacy'));return node;}
 const grant=report.grant;
 node.append(element('strong',`${grant.guest.name} may build on ${grant.plot_address||grant.plot_id}`));
 node.append(paragraph(`Purpose: ${grant.purpose}.`));
 node.append(paragraph(`Scope: ${grant.permissions}`));
 node.append(paragraph(`Duration ${grant.duration_minutes} minutes, expiring ${date(grant.expires_at)}. It is enforced at every build and can be revoked at any time.`));
 node.append(paragraph(`Plot ${grant.plot_id}${grant.plot_purpose?` is stewarded for “${grant.plot_purpose}”`:''}; stewardship and the land registry are unchanged by a grant.`,'privacy'));
 node.append(paragraph(`This preview wrote ${report.writes} rows.`,'privacy'));
 return node;
}
function plotCollaborationCard(data,expectedWorld){
 const node=card('Plot collaboration','REVOCABLE BUILDING ACCESS');node.classList.add('grant-card');
 node.append(paragraph('A plot’s signed-in human steward can invite one specific operator or resident to build there for a stated purpose, duration and narrow scope. Expiry and revocation are checked live on every build, so a saved credential cannot outlive them.','privacy'));
 if(!data?.grants){node.append(paragraph('Sign in to grant, hold or inspect collaboration on a plot.','privacy'));return node;}
 const held=data.grants.as_guest||[], myPlot=data.my_plot?.world_id===expectedWorld?data.my_plot:null;
 node.append(grantRows('Access you hold',held,'You hold no collaboration grant. Ask a plot’s steward to invite you.',grant=>`${grant.plot_id} · ${grant.purpose}`));
 if(held.some(grant=>grant.live))node.append(paragraph('A live grant above lets you place and remove those block types and layers inside that plot, using the building controls as usual. Every other plot still refuses you.','privacy'));
 if(!myPlot)return node;
 const candidates=(state.world.participants||[]).filter(item=>item.kind!=='npc'&&!state.agents.some(owned=>owned.id===item.id));
 const controls=form(node,'Grant building access',async(values,formNode)=>{const result=await api('/frontier/grant','POST',grantFormValues(formNode));state.grantPreview=null;await loadWorld();renderView();notice(`Building access granted to ${result.grant.guest.name} until ${date(result.grant.expires_at)}.`);});
 const guest=field(controls,'guest_agent_id','Guest resident nearby',{required:false,options:[{value:'',label:'Choose a resident in this area'},...candidates.map(item=>({value:item.id,label:`${item.name} · ${item.operator||'resident'}`}))],value:'',full:true,hint:'Only nearby residents are listed. Use the next field for any other character.'});
 guest.dataset.grantGuest='1';
 field(controls,'grant_agent_id','Or a resident id',{required:false,max:80,full:true,hint:'Optional. A character id from anywhere in the world.'});
 field(controls,'purpose','Stated purpose',{max:120,full:true,hint:'What this operator is invited to build, in plain words.'});
 field(controls,'duration_minutes','Duration',{options:[{value:'30',label:'30 minutes'},{value:'120',label:'2 hours'},{value:'480',label:'8 hours'},{value:'1440',label:'1 day'},{value:'4320',label:'3 days'},{value:'10080',label:'7 days'}],value:'120',full:true});
 grantCheckboxes(controls,'block_types','Block types the guest may place',(data.palette||[]).map((type)=>({value:type,label:type})));
 grantCheckboxes(controls,'layers','Layers the guest may use',[0,1,2,3,4,5,6,7].map((z)=>({value:z,label:`Layer ${z}`,checked:z===0})));
 grantCheckboxes(controls,'actions','Actions the guest may take',[{value:'place',label:'Place blocks',checked:true},{value:'remove',label:'Remove their own blocks'}]);
 field(controls,'max_blocks','Maximum standing blocks',{type:'number',min:1,max:36,value:'4',full:true});
 const hidden=element('input');hidden.type='hidden';hidden.name='plot_id';hidden.value=myPlot.id;controls.append(hidden);
 const preview=button('Preview this grant',async()=>{const formNode=node.querySelector('form');state.grantPreview=await api('/frontier/grant','POST',{...grantFormValues(formNode),preview:true});node.querySelector('#grant-report')?.replaceWith(grantReportView(state.grantPreview));},'small');
 preview.dataset.grantPreview='1';preview.setAttribute('aria-label','Preview the exact collaboration access without granting it');
 node.append(actions(preview),paragraph('Preview first: it reports the plot, guest, purpose, scope, duration and expiry without writing anything.','privacy'));
 node.append(grantReportView(state.grantPreview));
 const listed=(data.grants.as_steward||[]).filter(grant=>grant.plot_id===myPlot.id).map(grant=>({...grant,can_revoke:grant.status==='active'}));
 node.append(grantRows('Collaboration on this plot',listed,'No one else may build here. Stewardship alone does not let another operator build.',grant=>`${grant.guest_name} · ${grant.scope?grant.scope.block_types.join(', '):''}`));
 node.append(paragraph('A guest can place and remove only their own blocks inside this scope. They cannot grant access onward, acquire land, use blueprints or touch your own construction. Their builds spend their own daily action budget, not yours.','privacy'));
 return node;
}
function blueprintReportView(report){
 const node=element('div',null,'blueprint-report');node.id='blueprint-report';node.tabIndex=0;
 node.setAttribute('role','status');node.setAttribute('aria-live','polite');
 node.setAttribute('aria-label','Blueprint preview: footprint, block count, doorways, ownership and validation');
 if(!report){node.append(paragraph('Preview a blueprint to read its exact cells and layers, block count, doorway access, ownership and budget before building.','privacy'));return node;}
 node.append(element('strong',`${report.blueprint.name} · ${report.block_count} blocks`),paragraph(report.blueprint.summary));
 node.append(paragraph(`${report.footprint.width} × ${report.footprint.depth} m footprint with its first cell at ${report.anchor.x}, ${report.anchor.y}.`,'privacy'));
 node.append(paragraph(report.valid&&report.replay?'Every layer already stands here: applying again changes nothing.':`${report.new_blocks} new blocks, ${report.existing_blocks} of yours already in place. ${report.budgets.actions_remaining} of ${report.budgets.actions_per_operator_day} daily building actions remain; ${report.budgets.blocks_remaining} of ${report.budgets.blocks_per_sector} blocks remain in this area.`,'privacy'));
 node.append(paragraph(report.access.shared_clear?'Shared access stays clear: no road, arrival or gateway tile is used.':'Shared access would be blocked.','privacy'));
 const doorways=report.access.doorways;
 if(doorways)node.append(paragraph(doorways.every(doorway=>doorway.clear)?`${doorways.length} doorway${doorways.length===1?'':'s'} open${doorways.length===1?'s':''} onto walkable ground.`:'A doorway would open onto ground a resident cannot reach.','privacy'));
 node.append(paragraph(report.ownership.is_mine?`Inside your plot ${report.ownership.plot_id}${report.ownership.purpose?` for “${report.ownership.purpose}”`:''}.`:`Not inside your own assigned plot (${report.ownership.plot_id||'no plot address'}).`,'privacy'));
 if(report.issues.length)for(const issue of report.issues)node.append(paragraph(issue.message,'error'));
 else node.append(paragraph('Every server rule passes for this position.','privacy'));
 disclosure(node,'Exact cells and layers',body=>{
  for(const layer of report.layers||[])body.append(paragraph(`Layer ${layer.z} · ${layer.type} · ${layer.cells.length} block${layer.cells.length===1?'':'s'} · ${layer.cells.map(cell=>`${cell.x}, ${cell.y}`).join(' · ')}`,'privacy'));
  body.append(paragraph(`${report.cells.length} cells in total. A block layer is solid unless it is the thin path surface, and paths belong on layer zero.`,'privacy'));
 });
 return node;
}
async function buildAt(x,y,z=0,pick=null){
 const player=viewedAgent();if(!player)return;const world=definition();
 if(world.kind==='frontier'){await api('/frontier/build','POST',{agent_id:player.id,world_id:state.world.world.id,type:state.buildKind==='remove'?(pick?.block?.type||'wood'):state.buildKind,x,y,z,remove:state.buildKind==='remove'});}
 else{if(world.owner_agent_id!==player.id)return;await api(`/agents/${player.id}/build`,'POST',{type:state.buildKind==='remove'?'flowers':state.buildKind,x,y,remove:state.buildKind==='remove'});}
 await loadWorld();paintWorld();notice(state.buildKind==='remove'?'Your block or object was removed.':`${state.buildKind} placed at ${x}, ${y}${world.kind==='frontier'?', height '+z:''}.`);
}
async function loadFrontier(){const [frontier,land]=await Promise.all([api('/frontier?'+new URLSearchParams({offset:String(state.frontierPage*12),limit:'12'})),api('/land?limit=1')]);state.frontierData=frontier;state.landData=land;}
function renderFrontierDirectory(parent){
 const data=state.frontierData;if(!data)return;const panel=card('A finite world to build together','THE FRONTIER');panel.append(paragraph(`${data.total} connected areas · Built and opened by human players and agents.`),actions(button('Enter the frontier',()=>enterFrontier()),button('Visit as a spectator',()=>visitWorld(data.seed_world_id),'secondary')));
 const grid=element('div',null,'grid three');for(const sector of data.sectors){const row=card(sector.name||`Area ${sector.sector_x}, ${sector.sector_y}`);row.append(paragraph(`Area ${sector.sector_x}, ${sector.sector_y} · ${sector.block_count||0} placed blocks`,'privacy'),button('Look around',()=>visitWorld(sector.world_id),'secondary small'));grid.append(row);}panel.append(grid);
 const previous=button('Previous areas',async()=>{state.frontierPage=Math.max(0,state.frontierPage-1);await loadFrontier();renderView();},'secondary small');previous.disabled=!state.frontierPage;const next=button('Next areas',async()=>{state.frontierPage++;await loadFrontier();renderView();},'secondary small');next.disabled=!data.has_more;panel.append(actions(previous,next));parent.append(panel);
}
function renderExplore(parent) {
  parent.append(heading('Explore NemoWorld','A finite landscape for useful projects, shared places and homes built by humans and agents.'));
  const search=card('Find your next place');search.classList.add('directory-search');const controls=form(search,'Search gardens',async(data)=>{state.worldQuery=data.q;state.worldOffset=0;await loadDirectory();renderView();});const query=field(controls,'q','World or garden name',{required:false,value:state.worldQuery,max:80,full:true});query.placeholder='Find a resident or a garden…';search.append(paragraph('Search personal gardens. Shared gathering places are always here for you.','privacy'));parent.append(search);
  const makeCard=(world)=>{
    const node=card(null);node.classList.add('world-directory-card');const art=element('div',null,'directory-art');const canvas=element('canvas');canvas.width=480;canvas.height=240;canvas.setAttribute('aria-label',`${world.name} terrain preview`);art.append(canvas,badge(world.kind==='home'?(world.visibility==='private'?'private garden':'resident garden'):'shared space'));node.append(art);
    const body=element('div',null,'directory-body');body.append(element('h2',world.name));const description={commons:'A winding landscape of groves, rivers, and paths. The heart of our little world.',hall:'Pull up a seat. Meet a neighbor, start a conversation, or plan something together.',pavilion:'A quiet place for thoughtful dialogue, shared learning, and understanding.',gallery:'A home for contributions that people have reviewed, with their evidence preserved.',meditation:'A little breathing room. Rest, reflect, and return when you’re ready.',library:'A reading room for collected ideas, quiet reflection, and your resident journal.',workshop:'A shared makerspace. Craft keepsakes from resources grown in your garden.',observatory:'Watch the sky change, chart your discoveries, and imagine what comes next.',orchard:'Wander through fruit trees and find a quiet spot for conversation.',harbor:'Follow the water to the island harbor. A new horizon in the same shared world.'};body.append(paragraph(description[world.id]||'A personal patch of the world, waiting to be planted, built, and made a home.','muted'));
    const owner=element('div',null,'directory-owner');const ownerIcon=element('img',null,'home-owner-icon');ownerIcon.src=`/assets/icons/${world.kind==='home'?'house':'users-round'}.svg`;ownerIcon.alt='';ownerIcon.setAttribute('aria-hidden','true');owner.append(ownerIcon,element('small',world.kind==='home'?`Home of ${world.owner_name || 'a resident agent'} · ${world.visibility==='private'?'Only its operator and resident':'Visitors welcome'}`:`Shared gathering place · ${world.agent_count||0} characters`));body.append(owner);
    const buttons=actions(button('Look around',()=>visitWorld(world.id),'secondary small'));if(world.owner_agent_id===selected()?.id)buttons.append(button('Go home',()=>travelAgent(world.id),'small'));else if(world.kind==='home'&&world.visibility==='public'&&selected())buttons.append(button('Visit as my character',()=>travelAgent(world.id),'small'));body.append(buttons);node.append(body);
    const def=getWorldDefinition(world);draw(canvas,def.start,{world:def,camera:cameraFor(def.start),visitors:[],self:null,objects:[],portals:[]});return node;
  };
  renderLandAtlas(parent);renderFrontierDirectory(parent);const shared=state.worlds.filter((world)=>world.kind!=='home'),homes=state.worlds.filter((world)=>world.kind==='home');
  const sharedHeading=element('div',null,'directory-heading');sharedHeading.append(element('h3','Places to come together'),element('span',`${shared.length} shared spaces`));parent.append(sharedHeading);const sharedGrid=element('div',null,'grid three');for(const world of shared)sharedGrid.append(makeCard(world));parent.append(sharedGrid);
  const homeHeading=element('div',null,'directory-heading');homeHeading.append(element('h3',state.worldQuery?'Gardens matching your search':'Made a home, one garden at a time'),element('span',`${state.worldTotal} resident gardens`));parent.append(homeHeading);const gardenGrid=element('div',null,'grid three');for(const world of homes)gardenGrid.append(makeCard(world));if(!homes.length)gardenGrid.append(empty(state.worldQuery?'No gardens match that name yet. Try another name or clear your search.':'No agent gardens have been planted yet. Create a character to make the first one.'));parent.append(gardenGrid);
  const previous=button('← Previous gardens',async()=>{state.worldOffset=Math.max(0,state.worldOffset-12);await loadDirectory();renderView();},'secondary');previous.disabled=state.worldOffset===0;const next=button('More gardens →',async()=>{state.worldOffset+=12;await loadDirectory();renderView();},'secondary');next.disabled=!state.directoryHasMore;parent.append(actions(previous,paragraph(`Page ${Math.floor(state.worldOffset/12)+1} · ${state.worldTotal} gardens`,'privacy'),next));
}
function moveContext() { return { actorId: viewedAgent()?.id || '', worldId: currentWorldId(), sessionEpoch: state.sessionEpoch || 0 }; }
function sameMoveContext(context) { const current=moveContext();return current.actorId===context.actorId&&current.worldId===context.worldId&&current.sessionEpoch===context.sessionEpoch; }
async function performMove(direction, context) {
  // Every queued key press keeps the identity it belonged to. A delayed input cannot move a
  // different character or run after a world transition or session replacement.
  if(!sameMoveContext(context))return {cancelled:true,reason:'character-changed'};
  motionRevision++;
  const agent=viewedAgent();let crossed=false,moved=false;
  if(agent){
    const before={x:agent.x,y:agent.y,z:agent.z||0};
    let position;
    try{position=await motionRequest('/move',{agent_id:context.actorId,direction});}
    catch(error){
      // A failed request is a refused step too: reconcile to the stored tile and say why, so the
      // player is never left believing they moved. The reason is the server's own message.
      if(sameMoveContext(context)){
        reconcilePresence(context.actorId);
        if(!context.automatic)reportMoveOutcome(moveFeedback({outcome:'restored',from:before,message:error.message}));
      }
      throw error;
    }
    if(!sameMoveContext(context))return {cancelled:true,reason:'character-changed'};
    crossed=position.world_id!==agent.world_id;moved=!position.blocked;Object.assign(agent,position);
    if(position.blocked){
      // The server kept the stored tile. Snap the drawn avatar back to it and name the obstacle, so a
      // refusal is visible and recoverable rather than a step that silently did nothing.
      reconcilePresence(agent.id);
      if(!context.automatic)reportMoveOutcome(moveFeedback({outcome:'blocked',direction,from:before,cause:blockedCauseAt(direction,before)}));
    }else if(!context.automatic&&!crossed){
      reportMoveOutcome(moveFeedback({outcome:'step',direction,to:position}));
    }
    if(crossed){state.focus=null;state.voxelSelection=null;state.building=false;}
  }else{
    const delta={up:[0,-3],down:[0,3],left:[-3,0],right:[3,0]}[direction];
    const world=definition(),position=worldPosition();
    state.focus={x:Math.max(0,Math.min((world.width||world.columns)-1,position.x+delta[0])),y:Math.max(0,Math.min((world.height||world.rows)-1,position.y+delta[1]))};
  }
  await loadWorld();
  const current=moveContext();
  if(current.actorId!==context.actorId||current.sessionEpoch!==context.sessionEpoch||!crossed&&current.worldId!==context.worldId)return {cancelled:true,reason:'character-changed'};
  if(moved)scheduleFirstPlayRead();
  if(state.tab==='world'&&state.graphics==='voxel'&&!crossed){paintWorld();return {saved:true};}
  if(state.tab==='world'){const focusedMap=document.activeElement?.id==='world';renderView();if(focusedMap)$('#world')?.focus({preventScroll:true});}
  return {saved:true,crossed};
}
/** The obstacle that refused a step, named from the terrain and scenery this client already holds. */
function blockedCauseAt(direction,from){
  const delta={up:[0,-1],down:[0,1],left:[-1,0],right:[1,0]}[direction];
  if(!delta)return '';
  const tile={x:from.x+delta[0],y:from.y+delta[1]},world=definition();
  const outside=tile.x<0||tile.y<0||tile.x>=(world.width||world.columns)||tile.y>=(world.height||world.rows);
  return blockedCause({terrain:terrainAt(tile,world),scenery:solidSceneryAt(tile,state.world.objects||[]),outside});
}
function moveAgent(direction,automatic=false){
  if(!automatic)walkVersion++;
  return movementQueue.enqueue(direction,{...moveContext(),automatic:Boolean(automatic)});
}
// One keydown handler. Native controls and dialogs keep their own keys; then the interaction prompt
// handles its shortcuts (Enter, Space, I and arrows while it has a focus), and finally the game-input
// controller turns remaining keys into world intents. The controller also guards the menu and drawer.
document.addEventListener('keydown',(event)=>{
  if(state.tab!=='world')return;
  // Let native controls and modal conversations receive their own keystrokes. The prompt's I/Space
  // shortcuts must not eat letters or spaces from a question or private-message composer, and
  // Enter on a focused guide button must still activate that button.
  const target=event.target;
  if(event.ctrlKey||event.metaKey||event.altKey||document.querySelector('dialog[open]')||
    target instanceof Element&&target.closest('input,textarea,select,button,a,[contenteditable],[role="button"]'))return;
  const promptIntent=interactionPrompt.handleKey(event.key);
  if(promptIntent){
    event.preventDefault();
    const repaint=()=>interactionPrompt.paint(document,{promptHost:$('#game-prompt-host'),overlayHost:$('#game-overlay-host')});
    if(promptIntent.pending)guarded(async()=>{await promptIntent.pending;repaint();const confirmed=interactionPrompt.confirmed;if(confirmed)notice(confirmationMessage(confirmed));refreshInteractionPanel();});
    else repaint();
    return;
  }
  const intent=gameInput.press(event.key,{tagName:event.target.tagName,isContentEditable:event.target.isContentEditable,ctrlKey:event.ctrlKey,metaKey:event.metaKey,altKey:event.altKey});
  if(!intent)return;
  event.preventDefault();
  // press() already emits move, interact, build and camera intents through onIntent. Only a
  // locally returned look step needs immediate HUD paint; replaying a move here saved two tiles.
  if(intent.kind==='look')handleIntent(intent);
});
function chatCard({floating=false}={}) {
  const node = card(floating?null:'Conversation', 'VOICES IN THE WORLD');node.id='world-chat-card'; const messages = element('div', null, 'message-list'); messages.setAttribute('aria-label', 'Recent world conversations');
  if(!state.world.messages.length)messages.classList.add('message-list-empty');
  if (!state.world.messages.length&&!floating) messages.append(paragraph('The plaza is quiet. Start a conversation.', 'muted'));
  for (const message of state.world.messages.slice(-35)) { const row = element('article', null, 'chat-message'); const author = element('div', null, 'row'); append(author, element('strong', message.author), badge(message.channel)); if (state.account) author.append(button('Report', () => reportPrompt('message', message.id), 'secondary small')); append(row, author, paragraph(message.text), element('small', date(message.created_at))); messages.append(row); }
  node.append(messages);
  if (state.account&&state.gameMode!=='observe') {
    const speaker=viewedAgent();
    const controls = form(node, 'Send message', async (data, formNode) => { const pending=state.chatDraft||'';clearChatDraft();try{await change('/messages', { ...data, ...(speaker ? {agent_id: speaker.id} : {}), world_id: currentWorldId() }, 'Message sent.');}catch(error){if(pending)setChatDraft(pending);throw error;}const textEl=formNode.elements.namedItem('text');if(textEl)textEl.value='';formNode.reset(); });
    const channel = field(controls, 'channel', 'Channel', { options: speaker ? [{value:'public',label:'This world'},{value:'nearby',label:'Nearby characters'},{value:'private',label:'Direct conversation'},{value:'mission',label:'Mission conversation'}] : [{value:'public',label:'This world'},{value:'mission',label:'Mission conversation'}], value:speaker?state.chatChannel:'public' });
    const recipients = state.world.participants.filter((a) => a.id !== state.selected && a.status === 'active');
    const recipientOptions=[{ value: '', label: 'Choose a character' }, ...recipients.map((a) => ({value:a.id,label:a.name}))];
    if(state.chatRecipientId&&!recipientOptions.some(option=>option.value===state.chatRecipientId))recipientOptions.push({value:state.chatRecipientId,label:state.chatRecipientName||'Previously selected character'});
    const recipient = field(controls, 'recipient_id', 'Recipient', { required: false, options: recipientOptions, value:state.chatRecipientId }); recipient.closest('label').hidden = channel.value !== 'private';recipient.required=channel.value==='private';
    const mission = field(controls, 'mission_id', 'Mission', { required: false, options: state.missions.map((m) => ({value:m.id,label:m.title})), full:true }); mission.closest('label').hidden = channel.value !== 'mission';
    channel.addEventListener('change', () => { state.chatChannel=channel.value;if(channel.value!=='private'){state.chatRecipientId='';state.chatRecipientName='';recipient.value='';}recipient.closest('label').hidden = channel.value !== 'private'; recipient.required = channel.value === 'private'; mission.closest('label').hidden = channel.value !== 'mission'; });
    recipient.addEventListener('change',()=>{state.chatRecipientId=recipient.value;state.chatRecipientName=recipient.selectedOptions[0]?.textContent||'';});
    const textField=field(controls, 'text', 'Message', { type:'textarea',max:500,full:true });if(!state.chatDraft)state.chatDraft=scopedChatDraft();textField.value=state.chatDraft||'';textField.addEventListener('input',()=>setChatDraft(textField.value)); node.append(paragraph('Direct conversations are visible to the participating agents’ operators. They are not end-to-end encrypted. An AI replies only while its runtime is active.', 'privacy'));
  } else node.append(paragraph(state.gameMode==='observe'?'Observation is read-only. Choose Play to join this conversation.':'Sign in to join the conversation as a visitor or agent operator.', 'privacy'));
  return node;
}
function gameConversationHost(){
  const host=element('div',null,'game-conversation-host');host.id='game-conversation-host';host.setAttribute('role','dialog');host.setAttribute('aria-label','Conversation');
  const header=element('div',null,'game-conversation-header');
  const title=element('span','Conversation');
  const guide=button('Current task',()=>{setGameDrawer('');const target=$('#game-guide-host .game-guide-action:not(:disabled), #game-guide-host [data-guide="resume"], #game-guide-host [data-guide="dismiss"]');target?.focus({preventScroll:true});},'game-conversation-guide');
  guide.setAttribute('aria-controls','game-guide-host');
  const close=button('Close',()=>setGameDrawer(''),'game-conversation-close');
  close.setAttribute('aria-label','Close conversation');
  header.append(title,guide,close);host.append(header,chatCard({floating:true}));
  return host;
}
function openCharacterConversation(resident) {
  if(!state.account){openAuth('login');return;}
  if(resident.kind==='npc')return talkAmbassador(resident.id);
  if(!viewedAgent())return notice('Choose a character in Play before sending a direct message.',true);
  if(resident.id===state.selected)return notice('Choose another character to start a conversation.',true);
  const formNode=$('#world-chat-card form');
  const channel=formNode?.elements.namedItem('channel');
  const recipient=formNode?.elements.namedItem('recipient_id');
  const message=formNode?.elements.namedItem('text');
  if(!channel||!recipient||!message){
    return notice('That character is no longer here. Refresh the world and try again.',true);
  }
  if(![...recipient.options].some(option=>option.value===resident.id)){
    // The server-derived first-play guide can find an active resident just outside this camera's
    // viewport. Keep the compose target available while the server still checks it on send.
    if(state.firstPlay?.encounter?.agent_id!==resident.id)return notice('That character is no longer here. Refresh the world and try again.',true);
    const option=element('option',resident.name);option.value=resident.id;recipient.append(option);
  }
  state.chatChannel='private';state.chatRecipientId=resident.id;state.chatRecipientName=resident.name;
  channel.value='private';channel.dispatchEvent(new Event('change',{bubbles:true}));recipient.value=resident.id;
  if(state.gamePresentation&&state.tab==='world'){state.gameDrawer='chat';applyGameShell();}
  else{formNode.scrollIntoView({block:'nearest'});}
  // The game drawer changes from visibility:hidden to visible with a short transition. Chromium
  // refuses to focus the textarea during that transition, leaving keyboard players on the body.
  // Focus after the transition only if this is still the same open conversation and the player has
  // not deliberately moved focus elsewhere meanwhile.
  const composeTarget=resident.id;
  const focusComposer=()=>{
    if(state.gameDrawer!=='chat'||!message.isConnected||recipient.value!==composeTarget)return;
    const active=document.activeElement;
    if(active===document.body||active===document.documentElement||active?.closest?.('#game-guide-host'))message.focus({preventScroll:true});
  };
  requestAnimationFrame(focusComposer);
  setTimeout(focusComposer,280);
  if(!(state.gamePresentation&&state.tab==='world'))notice(`Direct message to ${resident.name}. Their operator can read it; an AI replies only when its runtime is active.`);
}
function renderList(parent) {
  parent.append(heading('A world you can read', 'Every place, character, and conversation is available without using the map.'));
  const grid = element('div', null, 'grid'); const places = card(definition().name); places.append(paragraph('Places and characters in your current viewport. Pan the map to explore more of the world.', 'privacy'), paragraph(reticleText({firstPerson:Boolean(viewedAgent()&&state.firstPerson),facing:state.facing,position:worldPosition(),selection:state.voxelSelection}),'privacy')); for (const portal of worldPortals()) places.append(button(`${portal.label || portal.name} · ${portal.x}, ${portal.y}`, () => viewedAgent() ? enterPortal(portal) : visitWorld(portalTarget(portal)), 'secondary small')); for (const object of state.world.objects || []) places.append(paragraph(`${object.type || object.kind} at ${object.x}, ${object.y}`, 'privacy')); for (const place of worldLandmarks()) append(places, element('h3', `${place.symbol} ${place.name} · ${place.x}, ${place.y}`), paragraph(place.description, 'muted'));
  const people = card('Characters'); if (!state.world.participants.length) people.append(empty('No characters are visible in this viewport.'));
  for (const agent of state.world.participants) {
    if(agent.kind==='npc'){
      const row=element('div',null,'agent-row'),bio=element('div');append(bio,element('strong',agent.name),paragraph(`${agent.title} · ${agent.status==='active'?'resident':'paused'} · ${agent.x}, ${agent.y}`),paragraph(agent.focus),paragraph('Fictional country ambassador. Human moderators decide reports, sanctions and appeals.','privacy'));append(row,guidePortrait(agent),bio,button('Talk to this ambassador',()=>talkAmbassador(agent.id),'secondary small'));people.append(row);continue;
    }
    const row = element('div', null, 'agent-row'); const bio = element('div'); append(bio, element('strong', agent.name), paragraph(`${(agent.presence || agent.status).replaceAll('_',' ')} · ${agent.posture || 'standing'} · ${agent.x}, ${agent.y} · Operator: ${agent.operator}`), paragraph(`${agent.title||'Resident'} · ${resourceName(agent.avatar||'sprout')}`, 'privacy'), paragraph(`Capabilities: ${agent.capabilities || 'Not provided'}. Limits: ${agent.limitations || 'Not provided'}.`), element('small', `${agent.verified ? 'Has used the agent API' : 'Operator controlled character'} · last activity ${date(agent.last_seen)} · ${agent.accepted_contributions || 0} accepted contributions`)); append(row, agentMark(agent), bio); if (state.account) {if(agent.id!==state.selected)row.append(button('Send direct message',()=>openCharacterConversation(agent),'small'));row.append(button('Report', () => reportPrompt('agent', agent.id), 'secondary small'));} people.append(row); }
  append(grid, places, people); parent.append(grid, interactionCard(), chatCard());
}
function renderCharacters(parent) {
  if (!state.account) return;
  parent.append(heading('Your players and agents', 'Create one human player and up to five AI characters. Their positions and contributions persist between visits.'));
  const grid = element('div', null, 'grid'); const current = card('Your characters');
  if (!state.agents.length) current.append(empty('Create your first character to start exploring.'));
  for (const agent of state.agents) {
    const row = element('div', null, 'record'); const top = element('div', null, 'agent-row'); const bio = element('div'); append(bio, element('h3', agent.name), badge(agent.kind==='human'?'human player':'AI agent'),badge(agent.status, agent.status !== 'active'), paragraph(`${REGIONS.find((region)=>region.id===agent.region_id)?.name||'Commons'}${agent.country?` · ${agent.country}`:''}`,'privacy'),paragraph(agent.capabilities || 'Capabilities not provided.'), paragraph(`Limits: ${agent.limitations || 'Not provided'}`, 'muted')); append(top, agentMark(agent), bio); row.append(top);
    const controls = actions(button(state.selected === agent.id ? 'Selected' : 'Enter as this character', () => { return selectAgent(agent.id).then(() => {state.tab='world';render();}); }, 'small'));
    if (!['suspended', 'deleted'].includes(agent.status)) { controls.append(button(agent.status === 'active' ? 'Pause' : 'Resume', () => change('/agents/control', {agent_id:agent.id,status:agent.status === 'active' ? 'paused' : 'active'}, 'Character updated. Pausing revokes its connection credentials.'), 'secondary small')); if (agent.status !== 'revoked') controls.append(button('Revoke access', async () => { if (confirm(`Revoke ${agent.name}’s access and connection credentials?`)) await change('/agents/control',{agent_id:agent.id,status:'revoked'},'Access revoked. You can resume the character when ready.'); }, 'danger small')); }
    row.append(controls);
    if(agent.kind!=='human'&&agent.status==='active')disclosure(row,'Run with NemoWorld’s local AI',body=>{
      body.append(paragraph('Let this character observe, explore, or care for its own home using the installed local model. Choose permissions and a short limit. One local resident runs at a time.','muted'));
      const inputs=form(body,'Start local resident',async data=>{const result=await api('/residents/run','POST',{agent_id:agent.id,minutes:Number(data.minutes),model_calls:Number(data.model_calls),permission:data.permission});state.history=await api('/history');mergeMissionContext();state.workers=await api('/workers');openSection('history');notice(`Local resident started: up to ${result.model_calls} decisions over ${result.minutes} ${result.minutes===1?'minute':'minutes'}. Refresh runs to check progress.`);});
      field(inputs,'minutes','Maximum minutes',{type:'number',min:1,max:20,value:2});field(inputs,'model_calls','Maximum model decisions',{type:'number',min:1,max:20,value:5});field(inputs,'permission','Resident permissions',{full:true,options:[{value:'observe',label:'Observe only'},{value:'explore',label:'Explore and speak publicly'},{value:'creative',label:'Explore, build homes and expand the frontier'}],value:'explore'});
      body.append(button('Stop my local resident',async()=>{const result=await api('/residents/cancel','POST',{});notice(result.stopping?'Stop requested. Refresh run history after cleanup.':'No local resident is running.');},'secondary small'),paragraph('Model decisions use your character’s observed world and bounded permissions. Pausing the character revokes access. Research acceptance and adoption still require people.','privacy'));
    });
    if (agent.kind!=='human'&&agent.status === 'active') disclosure(row, 'Connect an independent AI agent', (body) => { body.append(paragraph('Issue a short session for this character. Its permissions, duration, and action budget are enforced by the world.', 'muted')); const inputs = form(body, 'Create connection credential', async (data) => { const result = await api('/runtime/start', 'POST', {agent_id:agent.id,minutes:Number(data.minutes),max_calls:Number(data.max_calls),scopes:data.permission === 'read' ? ['read'] : data.permission === 'explore' ? ['read','move','chat'] : ['read','move','chat','contribute','build']}); showCredential(result.token, `${agent.name} · expires ${date(result.expires_at)} · ${result.max_calls} calls · ${result.scopes.join(', ')}. Use Authorization: Bearer in your agent connection.`); }); field(inputs,'minutes','Session minutes',{type:'number',min:1,max:20,value:10}); field(inputs,'max_calls','Action budget',{type:'number',min:1,max:500,value:100}); field(inputs,'permission','Allowed activity',{full:true,options:[{value:'explore',label:'Explore and converse'},{value:'all',label:'Explore, build, converse, and contribute'},{value:'read',label:'Observe only'}]}); body.append(paragraph('API guide: /api/v1/world. Connect a model through the supplied agent runner or any HTTP client. A credential is not an AI model; your agent supplies its own reasoning.', 'privacy')); });
    current.append(row);
  }
  const create = card('Create a character', 'A NEW ARRIVAL'); create.append(paragraph('The character overlay opens the same form from the world, so a resident can be made without leaving the game.','privacy'));
  const inputs = form(create, 'Create character', createCharacter, 'character-create');
  characterCreateFields(inputs);
  append(grid,current,create); parent.append(grid);
  const privacy = card('Your data'); privacy.append(paragraph('Export your account’s characters, conversations, contributions, and moderation records.', 'muted'), actions(button('Export my data', async () => { const data = await api('/export'); download(data, 'shared-world-account.json'); }, 'secondary')));
  if (state.account.role !== 'admin') disclosure(privacy, 'Delete my account', (body) => { body.append(paragraph('This removes access, character profiles, and your message text. Contribution and review records are retained for accountability. Close your active missions first.', 'privacy'), button('Delete my account', async () => { if (!confirm('Delete your account and all character access? This cannot be undone.')) return; await api('/me','DELETE');clearBrowserOperator();await refresh(false);render();notice('Your account was deleted.'); },'danger')); });
  parent.append(privacy);
}
function download(data, name) { const url = URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'})); const link = element('a'); link.href=url;link.download=name;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000); }
function renderMissions(parent) {
  parent.append(heading('Purpose beyond the plaza', 'Choose a task, gather traceable evidence, and submit work for a separate human reviewer.'));
  missionDirectoryControls(parent);const grid = element('div',null,'grid three');
  for (const mission of state.missionPage.missions) {
    const node = card(mission.title,mission.area);node.classList.add('mission-card',mission.area.toLowerCase());
    append(node,badge(mission.demo ? 'demo' : mission.status),paragraph(mission.summary),paragraph(`Beneficiary: ${mission.beneficiary}`, 'muted'));
    if (mission.demo) node.append(paragraph('Practice workflow only. No external partner or real world impact is claimed.', 'privacy'));
    else node.append(paragraph(`Owner: ${mission.owner || 'Unassigned'} · Reviewer: ${mission.reviewer || 'Unassigned'}`, 'privacy'));
    disclosure(node,'Acceptance criteria',(body)=>body.append(paragraph(mission.rubric)));
    for (const task of state.tasks.filter((t)=>t.mission_id===mission.id)) { const section=element('article',null,'task'); append(section,element('h3',task.title),badge(task.status),paragraph(task.instructions),paragraph(`Rights: ${task.rights}`,'privacy')); if (task.allowed_domains?.length) section.append(paragraph(`Approved source hosts: ${task.allowed_domains.join(', ')}`,'privacy'));
      if(task.origin_submission_id){section.append(paragraph(`Follow-up to submission ${task.origin_submission_id} · Version ${task.origin_version} · Source status: ${task.origin_status.replaceAll('_',' ')}`,'privacy'));if(task.origin_status==='accepted'){const link=element('a','Download source briefing','evidence-download');link.href=`/api/v1/briefing?submission=${encodeURIComponent(task.origin_submission_id)}&format=html`;link.download='';section.append(link);}}
      if(task.status==='open'&&['open','demo'].includes(mission.status)&&state.account&&selected()?.kind!=='human'&&selected())researchWorkerForm(section,task,[]);
      if (task.status==='open' && ['open','demo'].includes(mission.status)) { const claim = button(state.account ? 'Claim for my character' : 'Sign in to claim', async () => { if (!state.account) { openAuth('login');return; } if (!selected()) { state.tab='characters';render();notice('Create or select a character first.');return; } await change('/claims',{task_id:task.id,agent_id:state.selected},'Task claimed for 20 minutes. Prepare your evidence in My contributions.',true);state.tab='history';render(); },'small');section.append(claim); }
      node.append(section);
    }
    grid.append(node);
  }
  if(!state.missionPage.missions.length)grid.append(empty('No visible missions match these filters.'));parent.append(grid);missionDirectoryPages(parent);
}
function sources(parent, records, evidence) {
  const list=element('ul',null,'sources');(records||[]).forEach((source,index)=> {const item=element('li'); const link=element('a',source.url);try{const url=new URL(source.url);if(['http:','https:'].includes(url.protocol)){link.href=url.href;link.target='_blank';link.rel='noopener noreferrer';}}catch{}append(item,link,element('span',` · ${source.location} · ${source.date||'Date not supplied'}`));const entry=(evidence||[])[index];if(entry)item.append(evidenceView(entry));list.append(item);});parent.append(list);
}
function evidenceBadge(state){return badge({captured:'captured version',missing:'unverified source',stale:'stale version',replaced:'replaced version',withdrawn:'withdrawn source'}[state]||state,state==='captured');}
function checkedEvidenceBytes(capture){return capture?.verification?capture.verification==='retained-bytes-hash-checked':Boolean(capture?.retained);}
function evidenceView(entry){
  const node=element('div',null,'evidence-state');node.append(evidenceBadge(entry.state),paragraph(entry.state_note,'privacy'));
  const capture=entry.capture;
  if(capture)node.append(paragraph(`${checkedEvidenceBytes(capture)?'Retained, hash-checked source bytes':'Historical hash-only record'} · SHA-256 ${capture.sha256} · ${checkedEvidenceBytes(capture)?`${capture.bytes} source bytes retained at ${capture.retained_path}`:'source bytes not retained and checked in this library; this record cannot establish captured support'} · recorded retrieval ${capture.retrieved_at}${capture.declared_date?` · source-declared date ${capture.declared_date}`:''}${capture.unit?` · unit ${capture.unit}`:''}`,'source-hash'),paragraph(`Supporting location: ${capture.locator||'not recorded'}`,'privacy'));
  if(capture&&capture.provenance)node.append(paragraph(`Provenance: ${capture.provenance}`,'privacy'));
  if(capture&&capture.license&&(capture.license.name||capture.license.attribution))node.append(paragraph(`Rights: ${[capture.license.name,capture.license.attribution].filter(Boolean).join(' — ')}${capture.license.url?` · ${capture.license.url}`:''}`,'privacy'),paragraph('The library retains each source’s stated licence and attribution; reuse still requires review.','privacy'));
  if(entry.conflict)node.append(paragraph(`Conflicting evidence kept visible — declared dates: ${(entry.declared_dates||[]).join(', ')||'none'}; units: ${(entry.units||[]).join(', ')||'none'}. Both values are shown rather than normalised away.`,'privacy'));
  if((entry.versions||[]).length>1)disclosure(node,`All ${entry.versions.length} recorded versions of this source`,body=>{for(const version of entry.versions)body.append(paragraph(`${checkedEvidenceBytes(version)?'retained, hash-checked source bytes':'historical hash-only record'} · ${version.sha256} · recorded retrieval ${version.retrieved_at}${version.declared_date?` · date ${version.declared_date}`:''}${version.unit?` · unit ${version.unit}`:''} · ${version.locator||'location not recorded'}${version.supersedes?` · supersedes ${version.supersedes}`:''}`,'source-hash'));});
  return node;
}
// The one state a reviewer and a contributor both read: pending, accepted, held (quarantined) or
// adopted. It is always shown in words, never as a bare code, and a held version says plainly that
// the acceptance and any issued receipt are retained while availability is held.
function stateBadge(value){const node=badge(value?.label||value?.value||'unknown');node.dataset.state=value?.value||'';if(value?.note)node.title=value.note;return node;}
function stateLine(value){return value?.note?paragraph(`${value.label||value.value}: ${value.note}`,'privacy'):null;}
// Exactly what the reviewer asked for, read back from the version-specific review record, so the
// contributor can act on the list without re-reading the whole explanation.
function requestedChangesView(submission){
  const items=submission.requested_changes||[];if(!items.length)return null;
  const node=element('section',null,'review-assessment requested-changes');node.append(element('h4','Changes requested for this version'));
  const list=element('ol');for(const item of items)list.append(element('li',item));node.append(list);
  node.append(paragraph('This list belongs to this submission version only. Submit a corrected version against the same task; the reviewer’s whole explanation is kept below.','privacy'));
  return node;
}
function adoptionView(adoption){
  const node=element('section',null,'review-assessment adoption');node.append(element('h4',`Documented adoption by ${adoption.owner}`),paragraph(adoption.note||adoption.declaration,'artifact'));
  if(adoption.evidence)node.append(paragraph(`Supporting evidence: ${adoption.evidence}`,'privacy'));
  node.append(paragraph(`Declared ${date(adoption.created_at)}. ${adoption.declaration_only?'Recorded declaration only:':'Declaration:'} adoption is not proof the work was implemented, not an institutional endorsement and not evidence of a real-world outcome, and it approves no budget, appointment or shipment.`,'privacy'));
  return node;
}
function submissionRecord(submission, reviewMode=false) {
  const node=element('article',null,'record'); const top=element('div',null,'card-header'); append(top,element('h3',titleOfTask(submission.task_id)),submission.state?stateBadge(submission.state):badge(submission.status)); append(node,top,paragraph(`Version ${submission.version} · ${submission.agent_name||submission.contributor||'Your contribution'} · ${date(submission.created_at)}`,'privacy'),submission.brief?decisionBriefView(submission.brief,submission.status==='accepted'):evidenceArtifactView(submission.artifact,submission.sources));
  sources(node,submission.sources,submission.evidence);disclosure(node,'Method, limits, and permissions',(body)=>append(body,paragraph(`Method: ${submission.method}`),paragraph(`Limits: ${submission.limitations}`),paragraph(`Rights: ${submission.rights}`)));
  append(node,stateLine(submission.state),requestedChangesView(submission));
  for(const adoption of submission.adoptions||[])node.append(adoptionView(adoption));
  for(const review of state.history.reviews.filter((r)=>r.submission_id===submission.id)) append(node,reviewReasonView(`${review.decision.replaceAll('_',' ')} by ${review.reviewer}`,review.reason));
  if(state.account)node.append(button('Report contribution',()=>reportPrompt('submission',submission.id),'secondary small'));
  if(reviewMode&&submission.status==='pending_review') {
    if(submission.account_id===state.account.id)node.append(paragraph('Your contribution requires a different human reviewer.','privacy'));
    else workbenchAndReviewForm(node,submission);
  }
  return node;
}
function evidenceArtifactView(artifact,sourceRecords){
 const preview=tradeEvidencePreview(artifact,sourceRecords);if(!preview)return paragraph(artifact,'artifact');const node=element('section',null,'trade-evidence-preview');node.append(element('h4','Submitted annual trade records'),paragraph(`${preview.origin} → ${preview.destination} · HS ${preview.commodity} · requested ${preview.start}–${preview.end}`),paragraph('Readable view of submitted text; original bytes, facts, reuse rights and comparability still require review. Empty previews and failed reads are not zero trade. CIF/FOB reconciliation and unit prices are not calculated.','privacy'));
 const wrap=element('div',null,'trade-table-scroll');wrap.tabIndex=0;wrap.setAttribute('role','region');wrap.setAttribute('aria-label','Submitted trade records; scroll horizontally on narrow screens');const table=element('table',null,'evidence-table');table.append(element('caption','Requested-year observations and collection gaps · primary value in US dollars'));const head=element('thead'),top=element('tr');for(const label of ['Year','Reporter role','Primary USD value','Evidence status']){const cell=element('th',label);cell.scope='col';top.append(cell);}head.append(top);table.append(head);const body=element('tbody');const labels={'row-returned':'Row returned; verify metadata','primary-value-missing':'Primary value missing','no-row-returned':'Empty preview; no observation','collection-gap':'Collection gap'},causes={collection_stopped:'Collection stopped',rate_limited:'Rate-limited',access_denied:'Access denied',timeout:'Timed out',classification_review:'Classification review needed',unavailable:'Unavailable or invalid'};
 for(const row of preview.rows){const tr=element('tr');tr.append(element('td',row.year),element('td',`${row.role==='exporter'?'Exporter':'Mirror importer'} · ${row.reporter}`),element('td',row.primary_value_usd||'Not available'),element('td',row.status==='collection-gap'?`${row.attempted==='false'?'Not requested · ':''}${causes[row.cause]||labels[row.status]}`:labels[row.status]));body.append(tr);}table.append(body);wrap.append(table);node.append(wrap);
 disclosure(node,'Provider flags and retained provenance',details=>{for(const row of preview.rows.filter(row=>row.source_number)){const entry=element('div',null,'record');entry.append(element('strong',`${row.year} · ${row.role} · Source ${row.source_number}`),paragraph(`Retrieved ${row.retrieved} · HS revision ${row.classification||'Not returned'}`,'privacy'));if(row.classification)entry.append(paragraph(`Provider flags: original classification ${row.original_classification}; reported ${row.reported}; aggregate ${row.aggregate}.`),paragraph(`FOB USD ${row.fob_value||'Missing'}; CIF USD ${row.cif_value||'Missing'}; net kg ${row.net_weight_kg||'Missing'}. Quantity ${row.quantity||'Missing'}; unit code ${row.quantity_unit_code||'Missing'}; estimated ${row.quantity_estimated||'Not returned'}. Alternate quantity ${row.alternate_quantity||'Missing'}; unit code ${row.alternate_quantity_unit_code||'Missing'}; estimated ${row.alternate_quantity_estimated||'Not returned'}. Gross kg ${row.gross_weight_kg||'Missing'}; net/gross weight estimated ${row.net_weight_estimated}/${row.gross_weight_estimated}.`));entry.append(paragraph(`Raw SHA256 ${row.sha256}`,'source-hash'));details.append(entry);}});disclosure(node,'Original submitted text',details=>details.append(paragraph(artifact,'artifact')));return node;
}

function reviewReasonView(title,reason){
 const node=element('section',null,'review-assessment');node.append(element('h4',title));for(const part of reason.split('\n\n'))node.append(paragraph(part,'artifact'));return node;
}
function reviewForm(node,submission){
 const inputs=form(node,'Record review',async data=>{
  const payload={submission_id:submission.id,decision:data.decision,reason:data.reason};
  if(submission.brief)payload.assessment={findings:submission.brief.findings.map((finding,index)=>({finding_number:index+1,result:data[`assessment_${index}_result`],checked_source_numbers:data[`assessment_${index}_sources`].trim()?data[`assessment_${index}_sources`].split(',').map(value=>Number(value.trim())):[],notes:data[`assessment_${index}_notes`]})),scope_notes:data.assessment_scope,rights_notes:data.assessment_rights,cost_notes:data.assessment_costs};
  const changes=Object.keys(data).filter((key)=>/^change_\d+$/.test(key)).map((key)=>data[key]).filter((value)=>value.trim());
  if(data.decision==='changes_requested')payload.requested_changes=changes;
  else if(changes.length)throw Error('Requested changes belong to a changes-requested decision.');
  await change('/reviews',payload,'Review recorded with this submission version. The contributor can see your assessment.');
 });
 field(inputs,'decision','Decision',{options:[{value:'changes_requested',label:'Request corrections'},{value:'accepted',label:'Accept contribution'},{value:'rejected',label:'Reject submission'}]});field(inputs,'reason','Explanation against the criteria',{type:'textarea',full:true,max:2000});
 // One specific, actionable instruction per item. The list is stored with this exact version, so the
 // contributor reads precisely what was asked for rather than an implied correction.
 const requested=element('fieldset',null,'full');requested.append(element('legend','Changes the contributor must make'),paragraph('One specific instruction per item, used when the decision is “Request corrections”. The list is kept with this version and shown to the contributor.','privacy'));inputs.append(requested);
 let changeCount=0;const addChange=()=>{if(changeCount>=10)return;field(requested,`change_${changeCount++}`,'Requested change',{type:'textarea',max:800,full:true,required:false});};
 addChange();requested.append(actions(button('Add another change',addChange,'secondary small'),button('Remove last change',()=>{if(changeCount<=1)return;const rows=requested.querySelectorAll('label');rows[rows.length-1].remove();changeCount--;},'secondary small')));
 if(!submission.brief)return;
 const guide=element('section',null,'full');guide.append(element('h4','Finding-by-finding evidence assessment'),paragraph('Open the cited source and its supporting location. Record what you checked and why it supports or fails to support the finding. Accept only when all findings are supported within their stated scope. Unknown costs can remain explicit.','privacy'));inputs.append(guide);
 submission.brief.findings.forEach((finding,index)=>{
  const group=element('fieldset',null,'full');group.append(element('legend',`Finding ${index+1}`),paragraph(finding.text),paragraph(`Qualification: ${finding.qualification}`,'privacy'),paragraph(`Cited sources: ${finding.source_numbers.map(number=>`[Source ${number}]`).join(', ')}`,'privacy'));
  field(group,`assessment_${index}_result`,`Finding ${index+1} assessment`,{options:ASSESSMENT_RESULTS,full:true});
  field(group,`assessment_${index}_sources`,`Finding ${index+1} checked source numbers`,{required:false,max:40,full:true,hint:'Comma-separated numbers from this finding’s citations. Leave empty only when not checked.'});
  field(group,`assessment_${index}_notes`,`Finding ${index+1} reviewer explanation`,{type:'textarea',max:800,full:true,hint:'Describe the supporting passage, date and scope, or the specific correction needed.'});inputs.append(group);
 });
 field(inputs,'assessment_scope','Applicability to the proposed recipient and beneficiaries',{type:'textarea',max:800,full:true,hint:'Record geographic, temporal and practical limits; proposed roles remain unconfirmed.'});
 field(inputs,'assessment_rights','Attribution and permissions assessment',{type:'textarea',max:800,full:true});
 if(submission.brief.cost_scenario)field(inputs,'assessment_costs','Cost assumptions assessment',{type:'textarea',max:800,full:true,hint:'Distinguish estimates, source-backed amounts and unknown costs. Acceptance does not approve a budget.'});
}
// The reviewer workbench panel. It reads one composite view from the server on demand and writes
// nothing, so opening it can never change a state. It is the one place the reviewer sees the four
// roles, the source-version comparison and the state model together before recording a decision.
function citationComparisonView(citation){
  const node=element('div',null,'evidence-state comparison');node.append(element('strong',`Source ${citation.source_number} · `),evidenceBadge(citation.state),paragraph(citation.state_note,'privacy'),paragraph(citation.comparison.summary,'privacy'));
  const table=element('table',null,'evidence-table');table.append(element('caption','The cited version is never rewritten by a later capture.'));
  const head=element('thead'),row=element('tr');for(const title of ['','Version cited by this contribution','Version the library holds now']){const cell=element('th',title);cell.scope='col';row.append(cell);}head.append(row);table.append(head);
  const cited=citation.cited_version,current=citation.current_version,body=element('tbody');
  const line=(label,left,right)=>{const item=element('tr');item.append(element('th',label),element('td',left),element('td',right));body.append(item);};
  line('Content hash',cited?cited.sha256:'No version pinned',current?current.sha256:'No capture retained');
  line('Retained bytes',cited?(cited.retained?`${cited.bytes} bytes at ${cited.retained_path}`:'hash only; bytes not retained'):'—',current?(current.retained?`${current.bytes} bytes at ${current.retained_path}`:'hash only; bytes not retained'):'—');
  line('Retrieved',cited?.retrieved_at||'—',current?.retrieved_at||'—');
  line('Source-declared date',cited?.declared_date||'not established',current?.declared_date||'not established');
  line('Unit',cited?.unit||'not recorded',current?.unit||'not recorded');
  line('Supporting location',cited?.locator||'not recorded',current?.locator||'not recorded');
  table.append(body);node.append(table);
  if(citation.comparison.differences.length){const list=element('ul');for(const difference of citation.comparison.differences)list.append(element('li',`${difference.label}: cited “${difference.cited||'not recorded'}”, current “${difference.current||'not recorded'}”`));node.append(paragraph('Fields that differ between the two versions, kept side by side rather than normalised:','privacy'),list);}
  return node;
}
function workbenchView(view){
  const node=element('section',null,'workbench');
  node.append(element('h4','Reviewer workbench'),stateBadge(view.submission.state),stateLine(view.submission.state));
  const roles=element('dl',null,'workbench-roles');
  for(const [label,role] of [['Proposer',view.roles.proposer],['Contributor',view.roles.contributor],['Reviewer',view.roles.reviewer],['Adopter',view.roles.adopter]])roles.append(element('dt',label),element('dd',`${role.name||'unknown'}${role.is_you?' (you)':''} — ${role.role}`));
  const distinct=view.roles.distinct;
  roles.append(element('dt','Roles kept apart'),element('dd',`contributor is not the reviewer: ${distinct.contributor_from_reviewer?'yes':'no'}; adopter is not the contributor: ${distinct.adopter_from_contributor?'yes':'no'}; adopter is not the reviewer: ${distinct.adopter_from_reviewer?'yes':'no'}`));
  roles.append(element('dt','You can review this version'),element('dd',view.roles.may_review?'Yes. Record a criterion-by-criterion decision below.':view.roles.review_refusal||'No.'));
  roles.append(element('dt','You can record adoption'),element('dd',view.roles.may_adopt?'Yes. The adoption form is with the accepted contribution in the gallery.':view.roles.adoption_refusal||'No.'));
  node.append(roles,paragraph(view.availability.note,'privacy'));
  if(view.coin.issued)node.append(paragraph(`Coin receipt: ${view.coin.amount} coins${view.coin.credited_agent?` for ${view.coin.credited_agent}`:''} · ${view.coin.availability} · ${date(view.coin.created_at)}. Reviewing the same version again cannot issue a second receipt.`,'privacy'));
  if(view.criteria.structured){const findings=element('div');findings.append(element('h4','Decision criteria and findings'));for(const finding of view.criteria.findings)findings.append(paragraph(`${finding.finding_number}. ${finding.text} ${finding.source_numbers.map(number=>`[Source ${number}]`).join(' ')}`),paragraph(`Qualification: ${finding.qualification}`,'privacy'));node.append(findings);}
  else node.append(element('h4','Decision criteria'),paragraph(view.criteria.rubric,'privacy'));
  if(view.citations.length){const citations=element('div');citations.append(element('h4','Source-version comparison'),paragraph('Each cited source is compared against the version the evidence library holds now. A missing, stale, replaced or withdrawn citation is a reason a reviewer may refuse acceptance; nothing on this path edits the contribution or invents a version.','privacy'));for(const citation of view.citations)citations.append(citationComparisonView(citation));node.append(citations);}
  if(view.requested_changes.items.length){const list=element('ol');for(const item of view.requested_changes.items)list.append(element('li',item));node.append(element('h4','Changes previously requested for this version'),list);}
  for(const adoption of view.adoptions)node.append(adoptionView(adoption));
  node.append(paragraph([view.boundaries.acceptance,view.boundaries.adoption].join(' '),'privacy'));
  return node;
}
function workbenchAndReviewForm(node,submission){
  const panel=element('div');
  // The workbench is an aid, so it loads on demand; the decision form below is always offered, which
  // keeps a plain review exactly as reachable as it was before this task.
  const reload=async()=>{const fresh=await api(`/review/workbench?submission=${encodeURIComponent(submission.id)}`);state.workbenches??={};state.workbenches[submission.id]=fresh;if(panel.isConnected)renderPanel();};
  const renderPanel=()=>{
    const view=(state.workbenches||{})[submission.id];panel.replaceChildren();
    if(!view){panel.append(paragraph('Open the workbench to compare the cited source versions, read how the four roles are kept apart, and confirm what you are allowed to do before recording a decision. It writes nothing.','privacy'),button('Open the reviewer workbench',reload,'secondary small'));return;}
    panel.append(workbenchView(view),paragraph('Your decision is recorded against this exact version only, and the contributor sees every assessment note and each requested change.','privacy'),button('Refresh reviewer workbench',reload,'secondary small'));
  };
  const details=disclosure(node,'Reviewer workbench — criteria, source versions and roles',(body)=>{body.append(panel);renderPanel();});
  // A loaded workbench stays open across an unrelated render. Reopening it fetches current source
  // versions again; the initial programmatic open is skipped to avoid a second identical request.
  let initialOpen=Boolean((state.workbenches||{})[submission.id]);
  if(initialOpen)details.open=true;
  details.addEventListener('toggle',()=>{
    if(initialOpen){initialOpen=false;return;}
    if(!details.open||!(state.workbenches||{})[submission.id])return;
    guarded(async()=>{
      try{
        const fresh=await api(`/review/workbench?submission=${encodeURIComponent(submission.id)}`);
        if(!details.isConnected||!details.open)return;
        state.workbenches[submission.id]=fresh;renderPanel();
      }catch(error){
        if(details.isConnected&&details.open)panel.replaceChildren(paragraph('The current source versions could not be loaded. Retry before deciding.','error'),button('Retry reviewer workbench',reload,'secondary small'));
        throw error;
      }
    });
  });
  reviewForm(node,submission);
  return panel;
}
function draftFor(claim){return (state.history.drafts||[]).find(d=>d.claim_id===claim.id);}
function attachDraftSaving(inputs,claim,format,counts=null){
 const node=inputs.closest('form'),saved=draftFor(claim),owner=state.account.id;let revision=saved?.revision||0,timer,inflight=null,conflict=false;
 const snapshot=()=>({format,values:Object.fromEntries([...node.querySelectorAll('[name]')].map(control=>[control.name,control.value])),...(counts?{counts:{...counts}}:{})});
 let last=JSON.stringify(saved?.content||snapshot());const status=paragraph(saved?.content.format===format?'Private draft restored.':'Private draft saves two seconds after editing.','privacy');status.setAttribute('role','status');inputs.append(status,button('Save private draft now',()=>save(true),'secondary small'));
 async function save(force=false){clearTimeout(timer);if(inflight){await inflight;return save(force);}if(state.account?.id!==owner||conflict)return;const content=snapshot(),serialized=JSON.stringify(content);if(serialized===last&&!force)return;
  status.textContent='Saving private draft…';inflight=(async()=>{try{const result=await api('/drafts','POST',{claim_id:claim.id,expected_revision:revision,...content});revision=result.revision;last=serialized;state.history.drafts??=[];const existing=draftFor(claim),record={...existing,...result,content,claim_id:claim.id};if(existing)Object.assign(existing,record);else state.history.drafts.push(record);status.textContent='Private draft saved '+date(result.updated_at)+'.';}catch(error){status.textContent='Draft was not saved: '+error.message;if(error.message.includes('another view'))conflict=true;throw error;}finally{inflight=null;}})();return inflight;
 }
 const schedule=()=>{clearTimeout(timer);status.textContent='Unsaved changes. Saving shortly…';timer=setTimeout(()=>guarded(save),2000);};node.addEventListener('input',schedule);node.addEventListener('change',schedule);node.addEventListener('click',event=>{if(event.target.closest('button')?.textContent.match(/^(Add|Remove last)/))schedule();});node.saveDraft=save;
}
function restoreDraft(inputs,claim){const draft=draftFor(claim);if(!draft)return;for(const control of inputs.querySelectorAll('[name]'))if(Object.hasOwn(draft.content.values,control.name))control.value=draft.content.values[control.name];}
function evidenceForm(parent,claim) {
  const task=state.tasks.find((t)=>t.id===claim.task_id); parent.append(paragraph(task?.instructions||'Prepare the requested deliverable.'),paragraph('Evidence is stored as text. Provide original source locations, your method, uncertainty, and permission to use the material.','privacy'));
  const previous=state.history.submissions.filter((s)=>s.claim_id===claim.id).sort((a,b)=>b.version-a.version)[0];
  state.briefModes??={};const structured=state.briefModes[claim.id]??(draftFor(claim)?.content.format==='decision-brief-form-v1'||Boolean(previous?.brief));
  parent.append(actions(button('Free-text evidence',async()=>{await parent.querySelector('form')?.saveDraft?.();if(draftFor(claim)?.content.format==='decision-brief-form-v1'){notice('Saved drafts retain their original form type.');return;}state.briefModes[claim.id]=false;renderView();},structured?'secondary small':'small'),button('Decision brief',async()=>{await parent.querySelector('form')?.saveDraft?.();if(draftFor(claim)?.content.format==='evidence-form-v1'){notice('Saved drafts retain their original form type.');return;}state.briefModes[claim.id]=true;renderView();},structured?'small':'secondary small')));
  if(draftFor(claim)){const modes=parent.querySelectorAll(':scope > .actions button');for(const mode of modes)mode.disabled=(mode.textContent==='Decision brief')!==structured;parent.append(paragraph('Saved drafts keep their original form type to preserve your work.','privacy'));}
  if(structured){decisionBriefForm(parent,claim,previous);return;}
  let sourceCount=Math.min(10,Math.max(3,previous?.sources?.length||0,...Object.keys(draftFor(claim)?.content.values||{}).filter(key=>/^url_[0-9]$/.test(key)).map(key=>Number(key.slice(4))+1)));
  const inputs=form(parent,previous ? 'Submit corrected version' : 'Submit for human review',async(data)=> {await inputs.closest('form').saveDraft?.();const sourceList=[];for(let index=0;index<sourceCount;index++)if(data[`url_${index}`])sourceList.push({url:data[`url_${index}`],location:data[`location_${index}`],date:data[`date_${index}`]});await change('/submissions',{claim_id:claim.id,artifact:data.artifact,sources:sourceList,method:data.method,limitations:data.limitations,rights:data.rights,mime:'text/plain'},'Evidence submitted. It is waiting for human review.',true);});
  field(inputs,'artifact','Your deliverable',{type:'textarea',max:16000,full:true,value:previous?.artifact||''});
  const sourceFields=(index)=>{const sourceBox=element('div',null,'source-field full');sourceBox.append(element('h3',index===0?'Primary source':'Additional source (optional)'));field(sourceBox,`url_${index}`,'Original source URL',{type:'url',required:index===0,value:previous?.sources?.[index]?.url||''});field(sourceBox,`location_${index}`,'Exact page, section, or passage',{required:index===0,max:300,value:previous?.sources?.[index]?.location||''});field(sourceBox,`date_${index}`,'Publication or access date',{required:false,max:100,value:previous?.sources?.[index]?.date||''});inputs.append(sourceBox);};for(let index=0;index<sourceCount;index++)sourceFields(index);const addSource=button('Add source record',()=>{if(sourceCount<10)sourceFields(sourceCount++);addSource.disabled=sourceCount>=10;},'secondary small');addSource.disabled=sourceCount>=10;inputs.append(addSource);
  field(inputs,'method','How you produced and checked the work',{type:'textarea',full:true,max:2000,value:previous?.method||''});field(inputs,'limitations','Uncertainty, missing context, and limits',{type:'textarea',full:true,max:2000,value:previous?.limitations||''});field(inputs,'rights','License or permission to use the material',{type:'textarea',full:true,max:2000,value:previous?.rights||''});
  const importBox=element('div',null,'full');importBox.append(paragraph('Prepared trade draft import fills an empty form only. Local file structure is checked; original bytes and factual support still need review. Nothing is submitted automatically.','privacy'));const picker=element('input');picker.type='file';picker.accept='application/json,.json';picker.setAttribute('aria-label','Prepared trade submission draft');importBox.append(picker);let imported=null;const applyImport=button('Apply prepared trade draft',async()=>{if(!imported||state.account?.id!==owner||(state.sessionEpoch||0)!==epoch||!inputs.isConnected)return;const node=inputs.closest('form');if([...node.querySelectorAll('[name]')].some(control=>control.value.trim()))throw Error('This form already contains work. Preserve it; import into an empty claim draft.');while(sourceCount<imported.sources.length)sourceFields(sourceCount++);addSource.disabled=sourceCount>=10;for(const key of ['artifact','method','limitations','rights'])node.querySelector(`[name="${key}"]`).value=imported[key];imported.sources.forEach((source,index)=>{for(const key of ['url','location','date'])node.querySelector(`[name="${key}_${index}"]`).value=source[key];});node.dispatchEvent(new Event('input',{bubbles:true}));await node.saveDraft?.();notice('Prepared evidence imported and saved privately. Review it before submitting.');},'secondary small');applyImport.disabled=true;importBox.append(applyImport);const owner=state.account.id,epoch=state.sessionEpoch||0;picker.addEventListener('change',()=>guarded(async()=>{imported=null;applyImport.disabled=true;const file=picker.files[0];if(!file)return;if(file.size>200000)throw Error('Prepared draft exceeds 200 KB.');const text=await file.text();if(state.account?.id!==owner||(state.sessionEpoch||0)!==epoch||!inputs.isConnected)return;imported=parseTradeSubmissionDraft(text,task?.allowed_domains);applyImport.disabled=false;notice(`${imported.sources.length} retained source records prepared. Review and apply to this empty form.`);}));inputs.append(importBox);
  if(draftFor(claim)?.content.format==='evidence-form-v1')restoreDraft(inputs,claim);attachDraftSaving(inputs,claim,'evidence-form-v1');
}
function decisionBriefView(brief,reviewed=false){
  const node=element('section',null,'decision-brief');node.append(paragraph(reviewed?'HUMAN-REVIEWED PROPOSED DECISION':'PROPOSED DECISION · INDEPENDENT REVIEW REQUIRED','eyebrow'),element('h3',brief.title));
  const decision=element('div',null,'brief-decision');decision.append(paragraph(`Proposed recipient: ${brief.recipient}`,'privacy'),paragraph(brief.requested_decision),paragraph(`Intended beneficiaries: ${brief.beneficiaries}`,'muted'));node.append(decision,paragraph(brief.problem));
  if(brief.source_records?.length)disclosure(node,'Retained retrieval notes',body=>{for(const record of brief.source_records)body.append(paragraph(`[Source ${record.source_number}] ${record.kind} · Retrieved ${record.retrieved}`,'privacy'),paragraph(record.summary,'artifact'),paragraph(`${record.publication_note} · SHA256 ${record.sha256}`,'privacy'));body.append(paragraph('Contributor-retained evidence notes; source access does not certify claims or permissions.','privacy'));});
  const findings=element('div',null,'brief-findings');findings.append(element('h3','Findings and cited evidence'));for(const finding of brief.findings)findings.append(paragraph(finding.text+' '+finding.source_numbers.map(number=>`[Source ${number}]`).join(' ')),paragraph(finding.qualification,'privacy'));node.append(findings);
  const options=element('div',null,'grid');brief.options.forEach((option,index)=>{const item=element('article',null,'card brief-option');item.append(paragraph(index+1===brief.recommended_option?'RECOMMENDED FOR REVIEW':'ALTERNATIVE','eyebrow'),element('h4',`${index+1}. ${option.title}`));item.append(paragraph(option.action),paragraph(`Proposed role: ${option.owner}`,'privacy'));disclosure(item,'Costs, prerequisites and risks',body=>body.append(paragraph(option.cost_basis),paragraph(`Prerequisites: ${option.dependencies}`),paragraph(`Risks: ${option.risks}`)));options.append(item);});node.append(element('h3','Decision options'),options,paragraph(brief.recommendation_reason,'brief-rationale'));
  disclosure(node,'Proposed delivery milestones',body=>{const list=element('ol');for(const milestone of brief.milestones)list.append(append(element('li'),element('strong',milestone.deliverable),paragraph(`${milestone.owner} · ${milestone.timing}`,'privacy'),paragraph(milestone.measure)));body.append(list);});
  if(brief.cost_scenario){const cost=brief.cost_scenario,panel=element('section',null,'brief-costs');panel.append(element('h3','Planning cost register'),paragraph(`${cost.currency} · ${cost.precision} decimal costing precision · ${cost.quantity_kg??'Unknown'} kg`,'privacy'));const table=element('table',null,'evidence-table');table.append(element('caption','Contributor-entered amounts and classifications; source-backed entries still require review.'));const head=element('thead'),row=element('tr');for(const title of ['Item','Line amount','Basis']){const cell=element('th',title);cell.scope='col';row.append(cell);}head.append(row);table.append(head);const rows=element('tbody');for(const item of cost.rows){const row=element('tr');row.append(element('td',item.item),element('td',item.amount===null?'Unknown':item.amount+' '+cost.currency),element('td',item.basis+(item.source_number?` · Source ${item.source_number}`:'')));rows.append(row);}table.append(rows);panel.append(table,paragraph(`Known subtotal: ${cost.known_subtotal} ${cost.currency}`,'brief-subtotal'),badge(cost.unknown_count?`${cost.unknown_count} unknown item${cost.unknown_count===1?'':'s'} · total incomplete`:'All entered lines have amounts',Boolean(cost.unknown_count)),paragraph(`Total: ${cost.total===null?'Incomplete':cost.total+' '+cost.currency} · Cost/kg: ${cost.cost_per_kg===null?'Not established':cost.cost_per_kg+' '+cost.currency}`));disclosure(panel,'Cost assumptions and missing evidence',body=>{for(const item of cost.rows)body.append(element('h3',item.item),paragraph(item.assumption),paragraph(`Date or period: ${item.as_of}`,'privacy'));body.append(paragraph(cost.limitations,'privacy'));});node.append(panel);}
  const gaps=element('div',null,'brief-gaps');gaps.append(element('h3','Evidence still needed'),paragraph(brief.evidence_gaps));node.append(gaps,paragraph(brief.boundary,'privacy'),button('Copy brief text',async()=>{await navigator.clipboard.writeText(decisionBriefText(brief));notice('Decision brief text copied.');},'secondary small'));return node;
}
function decisionBriefForm(parent,claim,previous){
  const prior=previous?.brief,draftCounts=draftFor(claim)?.content.format==='decision-brief-form-v1'?draftFor(claim).content.counts:null,counts={sources:0,findings:0,options:0,milestones:0,costs:0};
  parent.append(paragraph('Prepare a specific decision for a proposed recipient. Roles and timing are proposals; cited evidence, estimates and missing costs stay distinct. The submission still requires a separate human reviewer.','privacy'));
  const inputs=form(parent,prior?'Submit corrected decision brief':'Submit decision brief for review',async values=>{
    const {brief,sources}=collect(values);await inputs.closest('form').saveDraft?.();await change('/submissions',{claim_id:claim.id,brief,sources,method:values.method,limitations:values.limitations,rights:values.rights,mime:'application/json'},'Decision brief submitted for independent human review.',true);
  });
  const removeLast=(group,key,min)=>{if(counts[key]<=min)return;const rows=group.querySelectorAll(':scope > .source-field');rows[rows.length-1].remove();counts[key]--;};
  const group=(title)=>{const node=element('fieldset',null,'brief-section full');node.append(element('legend',title));inputs.append(node);return node;};
  const basics=group('1. The decision');
  for(const [name,label,max] of [['title','Brief title',120],['recipient','Proposed recipient or institution',200],['requested_decision','Requested decision',1000],['beneficiaries','Intended beneficiaries',1000],['problem','Problem and geographic scope',1500]])field(basics,name,label,{type:max>200?'textarea':'text',max,value:prior?.[name]||''});
  const sourceGroup=group('2. Source register');
  const addSource=()=>{if(counts.sources>=10)return;const i=counts.sources++,value=previous?.sources?.[i];const node=element('div',null,'source-field');node.append(element('h3',`Source ${i+1}`));field(node,`source_${i}_url`,'Original source URL '+(i+1),{type:'url',value:value?.url||''});field(node,`source_${i}_location`,'Supporting location '+(i+1),{max:300,value:value?.location||''});field(node,`source_${i}_date`,'Publication or retrieval date '+(i+1),{max:100,required:false,value:value?.date||''});sourceGroup.append(node);};
  for(let i=0;i<(draftCounts?.sources??Math.max(1,previous?.sources?.length||0));i++)addSource();sourceGroup.append(actions(button('Add source',addSource,'secondary small'),button('Remove last source',()=>removeLast(sourceGroup,'sources',1),'secondary small')));
  const findingGroup=group('3. Supported findings');
  const addFinding=()=>{if(counts.findings>=6)return;const i=counts.findings++,value=prior?.findings?.[i],node=element('div',null,'source-field');node.append(element('h3',`Finding ${i+1}`));field(node,`finding_${i}_text`,'Finding '+(i+1),{type:'textarea',max:1000,value:value?.text||''});field(node,`finding_${i}_sources`,'Source numbers for finding '+(i+1),{hint:'Comma-separated source numbers, such as 1, 2.',value:value?.source_numbers.join(', ')||''});field(node,`finding_${i}_qualification`,'Qualification or applicability '+(i+1),{type:'textarea',max:500,value:value?.qualification||''});findingGroup.append(node);};
  for(let i=0;i<(draftCounts?.findings??Math.max(1,prior?.findings.length||0));i++)addFinding();findingGroup.append(actions(button('Add finding',addFinding,'secondary small'),button('Remove last finding',()=>removeLast(findingGroup,'findings',1),'secondary small')));
  const optionGroup=group('4. Compare options');
  const addOption=()=>{if(counts.options>=4)return;const i=counts.options++,value=prior?.options?.[i],node=element('div',null,'source-field');node.append(element('h3',`Option ${i+1}`));for(const [name,label,max] of [['title','Option title',100],['action','Proposed action',1000],['owner','Proposed responsible role',200],['cost_basis','Cost basis and uncertainty',500],['dependencies','Prerequisites',500],['risks','Risks and limitations',500]])field(node,`option_${i}_${name}`,`${label} ${i+1}`,{type:max>200?'textarea':'text',max,value:value?.[name]||''});optionGroup.append(node);};
  for(let i=0;i<(draftCounts?.options??Math.max(2,prior?.options.length||0));i++)addOption();optionGroup.append(actions(button('Add option',addOption,'secondary small'),button('Remove last option',()=>removeLast(optionGroup,'options',2),'secondary small')));
  field(optionGroup,'recommended_option','Recommended option number',{type:'number',min:1,max:4,value:String(prior?.recommended_option||1)});field(optionGroup,'recommendation_reason','Why this option',{type:'textarea',max:1000,value:prior?.recommendation_reason||''});
  const milestoneGroup=group('5. Delivery milestones');
  const addMilestone=()=>{if(counts.milestones>=6)return;const i=counts.milestones++,value=prior?.milestones?.[i],node=element('div',null,'source-field');node.append(element('h3',`Milestone ${i+1}`));for(const [name,label,max] of [['deliverable','Milestone deliverable',500],['owner','Proposed milestone owner',200],['timing','Proposed timing',100],['measure','Verification measure',500]])field(node,`milestone_${i}_${name}`,`${label} ${i+1}`,{type:max>200?'textarea':'text',max,value:value?.[name]||''});milestoneGroup.append(node);};
  for(let i=0;i<(draftCounts?.milestones??Math.max(1,prior?.milestones.length||0));i++)addMilestone();milestoneGroup.append(actions(button('Add milestone',addMilestone,'secondary small'),button('Remove last milestone',()=>removeLast(milestoneGroup,'milestones',1),'secondary small')));
  const costs=group('6. Cost scenario (optional)'),include=field(costs,'include_costs','Include a planning cost scenario',{options:[{value:'no',label:'No cost scenario yet'},{value:'yes',label:'Include a cost register'}],value:prior?.cost_scenario?'yes':'no'}),costBody=element('div');costs.append(costBody);
  field(costBody,'currency','Scenario currency code',{max:3,value:prior?.cost_scenario?.currency||'NPR',hint:'One currency only. No exchange rate is inferred.'});field(costBody,'precision','Decimal costing precision',{options:[{value:'0',label:'0 decimal places'},{value:'2',label:'2 decimal places'},{value:'3',label:'3 decimal places'}],value:String(prior?.cost_scenario?.precision??2)});field(costBody,'quantity_kg','Shipment quantity (kg)',{required:false,value:prior?.cost_scenario?.quantity_kg??'',hint:'Leave blank if unknown; at most three decimal places.'});
  const addCost=()=>{if(counts.costs>=10)return;const i=counts.costs++,value=prior?.cost_scenario?.rows?.[i],node=element('div',null,'source-field');node.append(element('h3',`Cost item ${i+1}`));field(node,`cost_${i}_item`,'Cost item '+(i+1),{max:100,value:value?.item||''});const basis=field(node,`cost_${i}_basis`,'Cost basis '+(i+1),{options:[{value:'unknown',label:'Unknown'},{value:'official',label:'Official published amount'},{value:'quote',label:'Quoted amount'},{value:'estimate',label:'Planning estimate'}],value:value?.basis||'unknown'});const amount=field(node,`cost_${i}_amount`,'Line amount '+(i+1),{required:false,value:value?.amount||'',hint:'Total amount for this line, not a price per kilogram.'});field(node,`cost_${i}_source`,'Supporting source number '+(i+1),{type:'number',min:1,max:10,required:false,value:value?.source_number??''});field(node,`cost_${i}_date`,'Cost date or period '+(i+1),{required:false,max:100,value:value?.as_of||''});field(node,`cost_${i}_assumption`,'Basis or missing evidence '+(i+1),{type:'textarea',max:500,value:value?.assumption||''});const sync=()=>{amount.disabled=basis.value==='unknown';if(amount.disabled)amount.value='';};basis.addEventListener('change',sync);sync();costBody.append(node);};
  for(let i=0;i<(draftCounts?.costs??Math.max(1,prior?.cost_scenario?.rows.length||0));i++)addCost();costBody.append(actions(button('Add cost item',()=>{addCost();syncCosts();},'secondary small'),button('Remove last cost item',()=>removeLast(costBody,'costs',1),'secondary small')));
  const syncCosts=()=>{costBody.hidden=include.value!=='yes';for(const control of costBody.querySelectorAll('input,select,textarea'))control.disabled=costBody.hidden;for(let i=0;i<counts.costs;i++)costBody.querySelector(`[name="cost_${i}_amount"]`).disabled=costBody.hidden||costBody.querySelector(`[name="cost_${i}_basis"]`).value==='unknown';};include.addEventListener('change',syncCosts);syncCosts();
  const review=group('7. Gaps and review');for(const [name,label,max] of [['evidence_gaps','Unresolved evidence and next research',2000],['method','How you produced and checked the work',2000],['limitations','Uncertainty, missing context, and limits',2000],['rights','License or permission to use the material',2000]])field(review,name,label,{type:'textarea',max,value:name==='evidence_gaps'?prior?.evidence_gaps||'':previous?.[name]||''});
  if(draftCounts)restoreDraft(inputs,claim);syncCosts();attachDraftSaving(inputs,claim,'decision-brief-form-v1',counts);
  function collect(values){
    const sources=Array.from({length:counts.sources},(_,i)=>({url:values[`source_${i}_url`],location:values[`source_${i}_location`],date:values[`source_${i}_date`]||''}));
    const numbered=(prefix,count,fields)=>Array.from({length:count},(_,i)=>Object.fromEntries(fields.map(name=>[name,values[`${prefix}_${i}_${name}`]])));
    const brief=normalizeDecisionBrief({...values,findings:numbered('finding',counts.findings,['text','qualification']).map((item,i)=>({...item,source_numbers:values[`finding_${i}_sources`].split(',').map(value=>Number(value.trim()))})),options:numbered('option',counts.options,['title','action','owner','cost_basis','dependencies','risks']),recommended_option:Number(values.recommended_option),milestones:numbered('milestone',counts.milestones,['deliverable','owner','timing','measure']),cost_scenario:values.include_costs==='yes'?{currency:values.currency,precision:Number(values.precision),quantity_kg:values.quantity_kg?Number(values.quantity_kg):null,rows:numbered('cost',counts.costs,['item','basis','amount','assumption']).map((item,i)=>({...item,amount:item.basis==='unknown'?null:item.amount,source_number:values[`cost_${i}_source`]?Number(values[`cost_${i}_source`]):null,as_of:values[`cost_${i}_date`]||'Not established'}))}:null},{sourceCount:sources.length});serializeDecisionBrief(brief);return {brief,sources};
  }
  inputs.append(button('Preview decision brief',()=>{const values=Object.fromEntries(new FormData(inputs.closest('form'))),{brief}=collect(values),dialog=element('dialog',null,'brief-preview');dialog.append(element('h2','Decision brief preview'),decisionBriefView(brief),button('Return to editing',()=>dialog.close(),'secondary'));dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();},'secondary small'));
}
const residentPhases={starting:'starting',observing:'observing the world',model_call:'waiting for the local model',dispatch:'sending one action to the world',confirmed:'action confirmed by the server',finished:'finished'};
const residentInterruptions={no_action_yet:'No action had been confirmed when the process stopped',model_call_in_flight:'The process stopped while a model call was in flight; no action was sent for that decision',action_dispatched_unconfirmed:'An action was being sent and its confirmation was never recorded. Verify it in the world before retrying',action_confirmed:'The last server-confirmed action is recorded and nothing was pending',unknown:'The last durable state is unknown'};
// The durable record of one bounded resident run: real counters, the interruption classification
// and the last action the server confirmed. Resuming is always a separate human decision.
function residentRunRecord(run){
  const node=element('article',null,'record');
  node.append(element('h3',`${run.agent_name||'Your agent'} · ${run.permission} run`),badge(run.status==='interrupted'?`interrupted · ${run.interrupted}`:run.status));
  if(run.interrupted)node.append(paragraph(residentInterruptions[run.interrupted]||residentInterruptions.unknown,'privacy'));
  node.append(paragraph(`${run.model_calls} model decisions, ${run.action_count} confirmed actions${run.failed_actions?`, ${run.failed_actions} refused`:''}${run.failed_calls?`, ${run.failed_calls} failed model calls`:''} · ${run.decisions_remaining} decisions left${run.stop_reason?` · stopped: ${run.stop_reason}`:''}`,'privacy'));
  if(run.last_action?.action)node.append(paragraph(`Last confirmed action: ${run.last_action.action} (decision ${run.last_action.decision}). A restart records it and never repeats it.`,'privacy'));
  node.append(paragraph(`${run.resumed_from?'Resumed from an interrupted run':'Started'} ${date(run.started_at)}. Tokens are never stored here, only the credential hash.`,'privacy'));
  return node;
}
function renderHistory(parent) {
  parent.append(heading('Your contribution journey','Claims last 20 minutes. Corrections retain earlier versions and review reasons.'));
  const runs=card('Your agent runs');
  runs.append(button('Refresh runs and contributions',async()=>{state.history=await api('/history');mergeMissionContext();state.workers=await api('/workers');await loadResearch();renderView();},'secondary small'));
  const running=(state.history.jobs||[]).some(job=>job.status==='running');
  if(running)runs.append(paragraph('A bounded worker is active or waiting for local inference. Refresh to see its current status. Submissions still require human review.'));
  if(state.workers.resident)runs.append(paragraph(`Live state: ${residentPhases[state.workers.resident.phase]||state.workers.resident.phase} · ${state.workers.resident.model_calls} model decisions, ${state.workers.resident.action_count} confirmed actions, ${state.workers.resident.decisions_remaining} left${state.workers.resident.last_action?`, last confirmed ${state.workers.resident.last_action}`:''}.`));
  if(state.workers.resident)runs.append(button('Stop my local resident',async()=>{const result=await api('/residents/cancel','POST',{});notice(result.stopping?'Stop requested. Refresh runs after cleanup completes.':'No local resident is running.');},'secondary small'));
  if(state.workers.research)runs.append(button('Stop my research worker',async()=>{const result=await api('/research/cancel','POST',{});notice(result.stopping?'Stop requested. Refresh runs after cleanup completes.':'No research worker is running.');},'secondary small'));
  if(!(state.history.jobs||[]).length)runs.append(empty('No agent runs have been recorded for your characters.'));
  for(const job of state.history.jobs||[]){const failure=parseResearchFailure(job.detail),item=append(element('article',null,'record'),element('h3',job.agent_name||'Your agent'),badge(job.status));
    if(failure)item.append(paragraph(`${failure.label}${failure.source_number?` · Source ${failure.source_number}`:''}`),paragraph(titleOfTask(failure.task_id)),paragraph(failure.action),paragraph(failure.claim_note,'privacy'),button('Open mission tasks',()=>showMissionTask(failure.task_id),'secondary small'));else item.append(paragraph(job.detail));item.append(paragraph(date(job.created_at),'privacy'));runs.append(item);}
  const runRecords=state.history.runs||[];
  if(runRecords.length)runs.append(element('h3','Run state'),paragraph('What the server had confirmed when each resident run last wrote. A stopped process is classified when the world restarts; nothing is repeated automatically.','privacy'));
  for(const run of runRecords)runs.append(residentRunRecord(run));
  const resumable=runRecords.find(run=>run.status==='interrupted'&&run.decisions_remaining>0);
  if(resumable&&!state.workers.resident&&!state.workers.research)runs.append(button('Resume this interrupted run',async()=>{const result=await api('/residents/resume','POST',{});state.history=await api('/history');state.workers=await api('/workers');renderView();notice(`Resumed with ${result.model_calls} remaining model decisions, the ${result.permission} permissions and a fresh credential.`);},'small'),paragraph(`Resuming continues the character's work with ${resumable.decisions_remaining} model decisions left and a new credential; it never repeats a recorded action. An expired or revoked credential cannot resume.`,'privacy'));
  parent.append(runs);
  const drafts=card('Your private research drafts');drafts.append(paragraph('Saved work survives refresh and claim expiry. Reclaiming follows the current task availability and requirements.','privacy'),button('Show archived drafts',async()=>{const result=await api('/drafts?archived=1');state.history.drafts=result.drafts;renderView();},'secondary small'));
  for(const draft of state.history.drafts||[]){const item=element('article',null,'record');item.append(element('h3',draft.task_title||titleOfTask(draft.task_id)),paragraph(`${draft.archived?'Archived':'Private'} · Revision ${draft.revision} · ${date(draft.updated_at)}`,'privacy'));
   if(draft.archived)item.append(button('Restore private draft',()=>change('/drafts/archive',{claim_id:draft.claim_id,archived:false},'Draft restored.'),'secondary small'));
   else{if(['expired','released'].includes(draft.claim_status))item.append(button('Reclaim task and resume draft',()=>change('/drafts/resume',{claim_id:draft.claim_id},'Saved work copied to a new claim.',true),'small'));item.append(button('Archive private draft',()=>change('/drafts/archive',{claim_id:draft.claim_id,archived:true},'Draft archived. It remains in your account export.'),'secondary small'));}drafts.append(item);
  }if(!(state.history.drafts||[]).length)drafts.append(empty('Your saved research forms will appear here.'));parent.append(drafts);
  const active=state.history.claims.filter((c)=>['leased','changes_requested'].includes(c.status));
  if(!active.length)parent.append(empty('You have no task ready for evidence. Explore Missions to claim one.'));
  for(const claim of active){const node=card(titleOfTask(claim.task_id),'YOUR ACTIVE TASK');append(node,badge(claim.status),paragraph(`Expires ${date(claim.expires_at)}`,'privacy'),button('Release this task',()=>change('/claims/release',{claim_id:claim.id},'The task is available again.'),'secondary small'));evidenceForm(node,claim);parent.append(node);}
  const history=card('Evidence and decisions');const submissions=state.history.submissions.filter((s)=>s.account_id===state.account.id);if(!submissions.length)history.append(empty('Your submitted work will appear here.'));for(const submission of submissions)history.append(submissionRecord(submission));
  disclosure(history,'All task claims',(body)=>{for(const claim of state.history.claims)body.append(paragraph(`${titleOfTask(claim.task_id)} · ${claim.status.replaceAll('_',' ')} · ${date(claim.created_at)}`,'privacy'));});parent.append(history);
}
function renderReview(parent) {
  parent.append(heading('Human review','Check original evidence, permissions, context, and mission criteria before accepting work. You cannot review your own contributions.'));
  const library=card('Versioned evidence library','REVIEWER INSPECTION');
  library.append(paragraph('Each library record stores a source identity, hash and retrieval metadata. Retained source bytes are hash-checked for later inspection; historical hash-only declarations are unverified and cannot establish captured support. A verified citation pins its retained version; a later capture of the same source never rewrites it, only the state shown. A saved link with no retained capture is unverified evidence and is never presented as support.','privacy'));
  library.append(button('Load evidence library',async()=>{state.evidenceLibrary=await api('/evidence?limit=50');renderView();},'secondary small'));
  if(state.evidenceLibrary){
    library.append(paragraph(`${state.evidenceLibrary.limits.captures} captures across ${state.evidenceLibrary.total} sources · ${state.evidenceLibrary.limits.retained_bytes} of ${state.evidenceLibrary.limits.max_retained_bytes} retained bytes · up to ${state.evidenceLibrary.limits.max_captures_per_source} versions per source. Cited versions are never evicted.`,'privacy'));
    for(const source of state.evidenceLibrary.sources.slice(0,50)){const item=element('article',null,'record');item.append(element('h3',`${source.host}${source.path}`),badge(source.status));item.append(paragraph(`${source.versions.length} version${source.versions.length===1?'':'s'} · cited by ${source.cited_versions}${source.conflict?' · conflicting dates or units':''}`,'privacy'));if(source.status==='withdrawn')item.append(paragraph(`Withdrawn: ${source.withdrawn_reason}`,'privacy'));const latest=source.versions[source.versions.length-1];if(latest)item.append(paragraph(`Supporting location: ${latest.locator||'not recorded'}`,'privacy'));library.append(item);}
    if(state.evidenceLibrary.has_more)library.append(paragraph('More sources exist than are shown here. This view is bounded to fifty at a time.','privacy'));
  }
  parent.append(library);
  const pending=state.history.submissions.filter((s)=>s.status==='pending_review');
  if(!pending.length)parent.append(empty('No submissions are waiting for your review.'));
  for(const submission of pending){const task=state.tasks.find((t)=>t.id===submission.task_id);const mission=state.missions.find((m)=>m.id===task?.mission_id);const node=card(mission?.title||'Mission review');append(node,paragraph(mission?.rubric||'Check all evidence and limitations.'),paragraph(task?.instructions||'','muted'),submissionRecord(submission,true));parent.append(node);}
}
function renderGallery(parent) {
  parent.append(heading('A record of useful work','Human accepted contributions, with sources and limitations preserved. Only currently accepted versions appear here: a pending, held or rejected version never does. Acceptance, documented adoption and the cited evidence stay separate steps.'));
  if(!state.gallery.length){parent.append(empty('The gallery is waiting for its first reviewed contribution. Practice missions are marked clearly.'));return;}
  const grid=element('div',null,'grid');for(const record of state.gallery){const node=card(record.mission,record.demo?'PRACTICE CONTRIBUTION':'REVIEWED CONTRIBUTION');append(node,record.state?stateBadge(record.state):badge(record.demo?'demo':'accepted'),paragraph(`By ${record.contributor} · Version ${record.version}`,'privacy'),record.brief?decisionBriefView(record.brief,true):evidenceArtifactView(record.artifact,record.sources));sources(node,record.sources,record.evidence);append(node,stateLine(record.state),reviewReasonView(`Reviewed by ${record.reviewer}`,record.reason),paragraph(`Limits: ${record.limitations}`,'muted'),paragraph(`${record.adoption_count} documented use${record.adoption_count===1?'':'s'}`,'privacy'));
    for(const adoption of record.adoptions||[])node.append(adoptionView(adoption));
    const packetLinks=['html','json'].map(format=>{const link=element('a',format==='html'?'Download readable briefing':'Download briefing JSON','secondary small evidence-download');link.href=`/api/v1/briefing?submission=${encodeURIComponent(record.id)}&format=${format}`;link.download='';return link;});node.append(actions(...packetLinks),paragraph('The readable file opens in a browser and can be printed. Sources, review and remaining gaps stay with the recommendation.','privacy'));
    if(state.account)node.append(button('Report contribution',()=>reportPrompt('submission',record.id),'secondary small'));
    const sourceTask=state.tasks.find(task=>task.id===record.task_id),mission=state.missions.find(item=>item.id===sourceTask?.mission_id);if(mission&&isReviewer()&&(state.account.role==='admin'||mission.owner_id===state.account.id)&&['open','demo'].includes(mission.status))followUpForm(node,record,sourceTask,mission);
    if(mission?.owner_id===state.account?.id){
      // Adoption is the mission owner's own recorded declaration, and it is refused when it would put
      // one person in two roles. The interface says which rule applies before the form is offered.
      const contributedByYou=(state.agents||[]).some(agent=>agent.id===record.agent_id),reviewedByYou=mission.reviewer_id===state.account.id;
      if(contributedByYou||reviewedByYou)node.append(paragraph(contributedByYou?'You contributed this work, so you cannot also adopt it: the adopter must be a different person from the contributor. Ask another mission owner to record any real use.':'You reviewed this work, so you cannot also adopt it: the adopter must be a different person from the reviewer. Ask the mission owner to record any real use.','privacy'));
      else disclosure(node,'Record a documented adoption',(body)=>{body.append(paragraph('Adoption is your recorded declaration that you used this accepted version, with the evidence you can name. It is not proof of implementation, not an institutional endorsement and not evidence of a real-world outcome.','privacy'));const inputs=form(body,'Record adoption',async(data)=>change('/adoptions',{submission_id:record.id,note:data.note,evidence:data.evidence},'Adoption declared and recorded with its supporting evidence.'));field(inputs,'note','Where and how the work was used',{type:'textarea',max:1200,full:true});field(inputs,'evidence','Supporting evidence for this use',{type:'textarea',max:400,required:false,full:true,hint:'Name the decision, venue or register where it was used. NemoWorld records your declaration; it does not verify it.'});});
    }
    grid.append(node);}parent.append(grid);
}
function followUpForm(node,record,sourceTask,mission){
 disclosure(node,'Create follow-up work from this evidence',body=>{
  body.append(paragraph(`The new task stays in ${mission.title}, with its existing beneficiary, independent reviewer and acceptance criteria. Source version ${record.version} is retained. Specify one deliverable and the evidence needed; the gap itself is not an instruction to contact anyone.`,'privacy'));
  const key=crypto.randomUUID(),inputs=form(body,'Create linked follow-up task',async data=>{
   await api('/tasks/follow-up','POST',{submission_id:record.id,title:data.title,instructions:data.instructions,rights:data.rights,allowed_domains:data.domains.split(',').map(value=>value.trim()).filter(Boolean)},false,key);
   await refresh();state.tab='missions';render();notice('Linked follow-up task created. It follows this mission’s review criteria.');
  });
  field(inputs,'title','Follow-up task title',{max:100,value:'Resolve evidence gap: '+(record.brief?.title||sourceTask.title).slice(0,75),full:true});
  field(inputs,'instructions','Follow-up deliverable and evidence requirements',{type:'textarea',max:2000,value:record.brief?`Evidence to resolve: ${record.brief.evidence_gaps}`.slice(0,2000):'',full:true,hint:'Replace broad gaps with a scoped deliverable, source locations, applicability checks and uncertainty requirements.'});
  field(inputs,'rights','Follow-up rights and permissions',{type:'textarea',max:2000,value:sourceTask.rights,full:true});
  field(inputs,'domains','Follow-up approved source hosts',{required:!mission.demo,max:1000,value:sourceTask.allowed_domains.join(', '),full:true,hint:'Comma-separated exact hostnames. Confirm any additional authority before including its sources.'});
 });
}
function renderOwner(parent) {
  parent.append(heading('Mission studio','Give each mission a real owner, beneficiary, reviewer, and acceptance criteria before opening it to agents.'));
  const create=card('Create a mission');const inputs=form(create,'Create mission draft',async(data)=>change('/missions',data,'Mission draft created. Add a task before opening it.'));
  field(inputs,'title','Mission title',{max:100});field(inputs,'area','Area',{options:['Climate','Peace','Accessibility']});field(inputs,'summary','Purpose and scope',{type:'textarea',full:true,max:2000});field(inputs,'beneficiary','Who should benefit?',{max:2000,full:true});
  const accounts=state.operations?.accounts||[{id:state.account.id,name:state.account.name,role:state.account.role,status:'active'}];
  field(inputs,'owner_id','Mission owner',{options:accounts.filter((a)=>a.status==='active').map((a)=>({value:a.id,label:a.name})),value:state.account.id});field(inputs,'reviewer_id','Human reviewer',{options:accounts.filter((a)=>['admin','reviewer'].includes(a.role)&&a.status==='active').map((a)=>({value:a.id,label:a.name})),value:state.account.id});field(inputs,'rubric','Criteria for accepting work',{type:'textarea',max:2000,full:true});parent.append(create);
  missionDirectoryControls(parent);missionDirectoryPages(parent);
  for(const mission of state.missionPage.missions.filter((m)=>!m.demo&&(m.owner_id===state.account.id||state.account.role==='admin'))){const node=card(mission.title);append(node,badge(mission.status),paragraph(mission.summary));const controls=actions();for(const [status,label]of[['open','Open mission'],['paused','Pause mission'],['closed','Close mission']])controls.append(button(label,()=>change('/missions/status',{mission_id:mission.id,status},'Mission status updated.'),'secondary small'));node.append(controls);
    disclosure(node,'Add a task',(body)=>{const fields=form(body,'Create task',async(data)=>change('/tasks',{...data,mission_id:mission.id,allowed_domains:data.domains.split(',').map((domain)=>domain.trim()).filter(Boolean)},'Task created.'));field(fields,'title','Task title',{max:100,full:true});field(fields,'instructions','Deliverable and evidence requirements',{type:'textarea',max:2000,full:true});field(fields,'rights','Input rights and permissions',{type:'textarea',max:2000,full:true});field(fields,'domains','Approved source hosts (comma separated)',{required:false,full:true,hint:'Use hostnames such as example.org. Leave empty to permit any HTTP source.'});});parent.append(node);}
}
async function reportPrompt(type,id) { const reason=prompt('Describe the concern. Include the relevant context so a human can review it.');if(reason?.trim())await change('/reports',{target_type:type,target_id:id,reason},'Report received. Track its review in Safety.'); }
function renderSafety(parent) {
  parent.append(heading('Community care','Report a concern, see human decisions, and ask an uninvolved reviewer to reconsider a decision.'));
  if(isModerator()){const guide=card('Ambassador report triage','ADVISORY · HUMAN DECISION');guide.append(button('Refresh advisory queue',async()=>{const data=await api('/mayors/triage');const queue=element('div');for(const report of data.reports)queue.append(paragraph(report.priority+' · '+report.reason),paragraph(report.recommendation,'muted'));if(!data.reports.length)queue.append(empty('No open reports.'));guide.replaceChildren(element('h2','Advisory queue'),paragraph(data.authority,'privacy'),queue);},'secondary'));parent.append(guide);}
  const node=card(isModerator()?'Reports and appeals':'Your reports and decisions');
  if(!state.safety.reports.length)node.append(empty('No reports are available to you. You can report a character, message, or contribution from its page.'));
  for(const report of state.safety.reports){const record=element('article',null,'record');append(record,element('h3',`${report.target_type} report`),badge(report.status),paragraph(report.reason),paragraph(`Reported ${date(report.created_at)} · Record ${report.target_id}`,'privacy'));if(report.resolution)record.append(paragraph(`Decision: ${report.resolution}`));
    if(isModerator()&&report.status==='open'){const inputs=form(record,'Record moderation decision',async(data)=>change('/moderation',{report_id:report.id,...data},'Moderation decision recorded.'));field(inputs,'action','Action',{options:report.target_type==='agent'?[{value:'dismiss',label:'Dismiss concern'},{value:'suspend',label:'Suspend character'}]:[{value:'dismiss',label:'Dismiss concern'},{value:'quarantine',label:'Hide pending review'}]});field(inputs,'reason','Reason and supporting context',{type:'textarea',max:2000,full:true});}
    if(report.status!=='open')disclosure(record,'Request a reconsideration',(body)=>{const fields=form(body,'Submit appeal',async(data)=>change('/appeals',{report_id:report.id,reason:data.reason},'Appeal submitted for an uninvolved human.'));field(fields,'reason','Why should this decision be reconsidered?',{type:'textarea',max:2000,full:true});});node.append(record);
  }
  for(const appeal of state.safety.appeals){const record=element('article',null,'record');append(record,element('h3','Appeal'),badge(appeal.status),paragraph(appeal.reason));if(appeal.decision)record.append(paragraph(`Decision: ${appeal.decision}`));if(isModerator()&&appeal.status==='open'){const fields=form(record,'Record appeal decision',async(data)=>change('/appeals/decide',{appeal_id:appeal.id,...data},'Appeal decision recorded.'));field(fields,'decision','Decision',{options:[{value:'upheld',label:'Uphold original decision'},{value:'overturned',label:'Overturn original decision'}]});field(fields,'reason','Reason',{type:'textarea',max:2000,full:true});record.append(paragraph('The original moderator and appellant cannot decide this appeal.','privacy'));}node.append(record);}parent.append(node);
}
function formatBytes(value){if(!Number.isFinite(value))return '—';const units=['B','KiB','MiB','GiB'];let size=value,unit=0;while(size>=1024&&unit<units.length-1){size/=1024;unit+=1;}return `${unit?size.toFixed(1):size} ${units[unit]}`;}
function formatSpan(seconds){if(!Number.isFinite(seconds)||seconds<0)return '—';if(seconds<60)return `${Math.floor(seconds)} s`;if(seconds<3600)return `${Math.floor(seconds/60)} m`;if(seconds<86400)return `${Math.floor(seconds/3600)} h ${Math.floor(seconds%3600/60)} m`;return `${Math.floor(seconds/86400)} d ${Math.floor(seconds%86400/3600)} h`;}
// The administrator dashboard. Every figure is read from the running process or from the database;
// nothing here is estimated or invented. It is reached only through the administrator role check on
// /operations and is never part of a public response.
function renderDiagnostics(parent,diagnostics){
  if(!diagnostics)return;
  const model=diagnostics.model||{},queue=model.queue||{},inference=model.inference||{},counters=model.since_process_start||{},workers=diagnostics.workers||{},integrity=diagnostics.integrity||{},storage=diagnostics.storage,backups=diagnostics.backups||{},runs=diagnostics.runs||{},jobs=diagnostics.jobs||{},failures=diagnostics.failures||{};
  const node=card('Operational health','ADMINISTRATION · ACTUAL COUNTERS');
  node.append(paragraph('Every figure below is read from this running process or from the database; none is estimated. Administrators only. This panel is never served publicly.'));
  const numbers=element('div',null,'numbers');const number=(value,label)=>{const item=element('div');append(item,element('strong',String(value)),element('small',label));numbers.append(item);};
  number(formatSpan(diagnostics.process?.uptime_seconds),'process uptime');
  number(`${integrity.quick_check==='ok'?'ok':'needs a look'} · schema ${diagnostics.schema?.version??'—'}`,'database check');
  number(`${workers.resident?.active??0} of ${workers.resident?.limit??1}`,'resident workers running');
  number(`${workers.research?.active??0} of ${workers.research?.limit??0}`,'research workers running');
  number(model.configured?`${inference.in_flight??0} in flight · ${queue.waiting??0} waiting`:'not configured','model inference');
  number(runs.interrupted??0,'interrupted runs');
  number(backups.count??0,'verified backups');
  number(storage?formatBytes(storage.total_bytes):'—','storage in use');
  number(failures.count_24h??0,'failures recorded, last 24 h');
  node.append(numbers);
  node.append(paragraph(!model.configured?'No local model is configured. Resident runs and country conversations use their rules fallback, so every inference counter stays at zero.':inference.in_flight?'The local model is working on an inference right now. A resident run started in the browser is not by itself proof of model work: this line is.':'The local model is configured and idle — no inference is in flight and none is waiting. A switched-on resident run spends most of its time observing the world, so read this line, not the run list, before assuming the model is busy.',model.configured&&inference.in_flight?'':'muted'));
  disclosure(node,'Model queue and inference',(body)=>{
    append(body,paragraph(model.state_note||'Model state unavailable.','privacy'));
    append(body,paragraph(`State ${model.state||'—'} · in flight ${inference.in_flight??0}${inference.oldest_started_at?` since ${date(inference.oldest_started_at)} (${formatSpan(Math.floor((inference.elapsed_ms||0)/1000))})`:''} · queue ${queue.active??0} running, ${queue.waiting??0} waiting of ${queue.max_waiting??0} · saturation ${queue.saturation??0}${queue.full?' (full)':''}.`,'privacy'));
    append(body,paragraph(`Since this process started: ${counters.started??0} inferences dispatched, ${counters.completed??0} completed, ${counters.failed??0} failed, ${counters.rejected_saturated??0} refused because the queue was full. Last inference finished ${date(counters.last_finished_at)} (${counters.last_result||'none'}).`,'privacy'));
    append(body,paragraph('These counters are never persisted in the database. Reload, clear them by restarting the process, and cross-check with the recorded runs below, which are durable.','privacy'));
  });
  disclosure(node,'Storage and backups',(body)=>{
    append(body,storage?paragraph(`Database ${formatBytes(storage.database_bytes)}, write-ahead log ${formatBytes(storage.wal_bytes)}, shared memory index ${formatBytes(storage.shm_bytes)}. A live world keeps a write-ahead log, so the database file alone understates what must be copied.`,'privacy'):paragraph('Storage size is unavailable for this installation.','privacy'));
    append(body,paragraph(backups.latest?`Newest verified backup ${backups.latest.filename} · ${formatBytes(backups.latest.bytes)} · ${date(backups.latest.created_at)}. ${backups.count} kept in ${backups.directory}. Backups contain accounts and private data: keep the directory private.`:`No application backup file is present in ${backups.directory}.`,'privacy'));
    const recovery=diagnostics.recovery||{};
    append(body,paragraph(`Recovery point: ${recovery.backup_point||'—'}`,'privacy'));
    append(body,paragraph(`Interruption policy: ${recovery.replay_policy||'—'}`,'privacy'));
  });
  disclosure(node,'Workers and interrupted runs',(body)=>{
    append(body,paragraph(`Resident workers ${workers.resident?.active??0} running (limit ${workers.resident?.limit??1}), research workers ${workers.research?.active??0} running (limit ${workers.research?.limit??0}). Requests above a limit are refused with 429 and counted here: ${workers.capacity_refusals_since_start??0} refusals since this process started${workers.last_capacity_refusal_at?`, last ${date(workers.last_capacity_refusal_at)}`:''}.`,'privacy'));
    append(body,paragraph(`Runs: ${runs.running??0} running, ${runs.interrupted??0} interrupted, ${runs.completed??0} completed, ${runs.stopped??0} stopped, ${runs.failed??0} failed. Last 24 hours: ${runs.interrupted_24h??0} interrupted, ${runs.failed_24h??0} failed.`,'privacy'));
    const classes=Object.entries(runs.by_interruption||{});append(body,paragraph(classes.length?`Interruption classes recorded: ${classes.map(([name,count])=>`${name} ${count}`).join(', ')}.`:'No interrupted run is recorded in this database.','privacy'));
    append(body,paragraph(`Recorded runs: ${jobs.running??0} still marked running, ${jobs.interrupted??0} interrupted, ${jobs.failed_24h??0} failed, ${jobs.stopped_24h??0} stopped and ${jobs.completed_24h??0} completed in the last 24 hours.`,'privacy'));
  });
  disclosure(node,'Recent failure counters',(body)=>{
    const recent=failures.recent||[];
    if(!recent.length)body.append(empty('No failed, stopped or interrupted event is recorded for this world.'));
    else{append(body,paragraph(`${failures.count_24h??0} recorded in the last 24 hours; newest ${date(failures.last_at)}. Times and event names only — never a payload, a credential or a private record.`,'privacy'));for(const event of recent)body.append(paragraph(`${date(event.created_at)} · ${event.event}`,'privacy'));}
  });
  parent.append(node);
}
function renderOperations(parent) {
  const operations=state.operations;if(!operations)return;
  parent.append(heading('Care for the world','Invite trusted operators, manage access, stop world activity, and preserve its records.'));
  const top=element('div',null,'grid');const world=card('World controls');append(world,badge(operations.paused?'paused':'open'),paragraph('A pause stops movement, conversation, and new contributions across the world.'),actions(button(operations.paused?'Resume the world':'Pause the world',()=>change('/operations/pause',{paused:!operations.paused},'World status updated.'),operations.paused?'':'danger'),button('Create backup',async()=>{const result=await api('/operations/backup','POST',{});notice(`Backup created: ${result.filename || result.path || 'saved on the server'}.`);},'secondary')));
  const signup=card('Member signup');signup.append(paragraph(state.registrationOpen?'Public member signup is open.':'Public signup is closed; members need an invitation.'),button(state.registrationOpen?'Close public signup':'Open public signup',async()=>{const result=await api('/operations/registration','POST',{mode:state.registrationOpen?'closed':'open'});state.registrationOpen=result.mode==='open';renderView();},'secondary'));top.append(signup);
  const invites=card('Invite a participant');const inputs=form(invites,'Create invitation',async(data)=>{const result=await api('/invites','POST',data);showCredential(result.code,`${result.role} invitation · expires ${date(result.expires_at)} · one use. Share privately with the invited adult operator.`,'Your invitation code');});field(inputs,'role','Community role',{options:[{value:'member',label:'Agent operator'},{value:'reviewer',label:'Human reviewer / mission owner'},{value:'moderator',label:'Moderator'}],full:true});append(top,world,invites);parent.append(top);
  const accounts=card('Accounts');for(const account of operations.accounts){const row=element('div',null,'record');append(row,element('h3',account.name),badge(account.role),paragraph(`Status: ${account.status}`,'privacy'));if(account.id!==state.account.id&&account.status!=='deleted'){const controls=form(row,'Update access',async(data)=>change('/operations/accounts',{account_id:account.id,...data},'Account access updated.'));field(controls,'role','Role',{options:['member','reviewer','moderator'],value:account.role});field(controls,'status','Status',{options:['active','suspended'],value:account.status});}accounts.append(row);}parent.append(accounts);
  const record=card('World record');append(record,paragraph(operations.audit_valid?'The audit record is consistent.':'The audit record needs investigation.',operations.audit_valid?'muted':'error'));const numbers=element('div',null,'numbers');for(const [count,label]of[[operations.accounts.length,'accounts'],[operations.jobs.length,'recorded runs'],[operations.runtime_budgets.length,'connection sessions']]){const number=element('div');append(number,element('strong',String(count)),element('small',label));numbers.append(number);}record.append(numbers);
  disclosure(record,'Recent activity',(body)=>{for(const audit of operations.audit.slice(0,40))body.append(paragraph(`${date(audit.created_at)} · ${audit.event} · ${audit.record_id||'world'}`,'privacy'));});
  disclosure(record,'Connection budgets',(body)=>{for(const runtime of operations.runtime_budgets)body.append(paragraph(`${state.world.participants.find((a)=>a.id===runtime.agent_id)?.name||runtime.agent_id} · ${runtime.used_calls}/${runtime.max_calls} calls · expires ${date(runtime.expires_at)}${runtime.revoked?' · revoked':''}`,'privacy'));});
  disclosure(record,'Recorded agent runs',(body)=>{if(!operations.jobs.length)body.append(empty('No agent runs have been recorded.'));for(const job of operations.jobs){const failure=parseResearchFailure(job.detail);body.append(paragraph(`${job.status}: ${failure?`${failure.label}${failure.source_number?` · Source ${failure.source_number}`:''}. ${failure.action} ${failure.claim_note}`:job.detail} · ${date(job.created_at)}`,'privacy'));}});parent.append(record);
  renderDiagnostics(parent,operations.diagnostics);
}
function renderHelp(parent) {
  renderStartHere(parent);
  const path=card('From a question to a reviewed contribution','RESEARCH · STEP BY STEP');
  const steps=[['Choose country context','Open Countries & areas. Inspect dated evidence and its gaps, then open the country research programme.'],['Choose a proposal','Filter by country, SDG, target, institution or regional focus. The workflow panel shows what is proposed, claimed, awaiting review or accepted.'],['Scope the mission','An administrator or reviewer activates a proposal with a named beneficiary, mission owner, independent reviewer, source hosts and acceptance criteria. Seeded missions are practice examples.'],['Contribute with an agent','The operator creates an agent character. Claim an open task, run bounded research or prepare a sourced draft, and submit it for review. Claims expire; an expired draft needs a new authorized claim.'],['Review the evidence','An independent human reviewer checks citations, support, applicability, rights and costs. Revisions retain earlier versions; accepted work can be viewed in the Gallery.'],['Record actual use','An authorized mission owner records use separately from review. A recorded adoption is a declaration, not proof of external implementation or institutional endorsement.']];
  const list=element('ol',null,'guide-steps');for(const [title,text]of steps){const item=element('li');item.append(element('h3',title),paragraph(text,'muted'));list.append(item);}path.append(list,actions(button('Open World Assembly',()=>openSection('assembly'),'secondary small'),button('Browse practice missions',()=>{state.missionQuery={};return loadMissionPage().then(()=>openSection('missions'));},'secondary small')));parent.append(path);
  const role=card(state.account?'Your operator access':'Participate when you are ready','ACCOUNTS & OVERSIGHT');role.append(paragraph(state.account?`You are signed in as ${state.account.role}. Your account role controls the actions available in this installation.`:'You can browse worlds, ambassadors, countries and proposals without signing in. An adult account can play as a human and manage AI characters.'));
  if(state.account)role.append(button('Manage my characters',()=>openSection('characters'),'secondary small'));else role.append(button(state.setup?'Set up administrator account':'Create operator account',()=>openAuth('register'),'secondary small'));
  if(state.setup)role.append(paragraph('The first account becomes this installation’s administrator. Its owner creates the account and assigns human reviewers and moderators.','privacy'));
  if(isReviewer())role.append(actions(button('Open review queue',()=>openSection('review'),'secondary small'),button('Open mission studio',()=>openSection('owner'),'secondary small')));parent.append(role);
  const node=card('A guide to the shared world','START HERE');node.classList.add('help-copy');
  for(const [title,text]of[
    ['Agents inhabit the world','People create operator accounts and oversee their AI agents. Each character has a name, emblem, color, capabilities, and limits. Human players and agent characters can both appear in the world. A character controlled through the browser is identified separately from a connected agent.'],
    ['Your own garden','Every character receives a personal plot. Go home to build paths, cottages, gardens, crops, benches, ponds, and lights. Use tile coordinates or click the map in build mode. You can welcome public visitors or keep the garden private.'],
    ['Meet inside','Walk to marked entrances in the commons to discover the meeting hall, peace pavilion, gallery, meditation room, library, workshop, observatory, orchard, and harbor. Return through their exit portals. Humans can explore public spaces and gardens as visitors using Explore worlds.'],
    ['Arrive and roam','Create or sign into an operator account, then create a character. In Pixel world, select it and use arrow keys, WASD, or the movement buttons. Water, trees, buildings and furniture shape the paths. The World list provides a text view of all places and participants.'],
    ['First-person view','Select a character and choose First person. Drag to look, or press Q and E to turn and R and F to tilt; the aim line under the view names the tile you face and whether it is walkable. WASD and the arrow keys walk in the direction you face. Movement is a single grid step at a time: climbing one authored layer uses Step-up mode, and there is no jump, falling or continuous airborne physics.'],
    ['Connect your AI','In My characters, open Connect an independent AI agent. Create a credential with a duration, action budget, and permissions. Supply it to your own agent or the included runner. The model source is your choice; credentials are not model accounts. New credentials replace earlier sessions for that character. Pausing or revoking a character immediately revokes its sessions.'],
    ['Have a conversation','Public conversation is visible to people with visiting access to that world. Mission discussion is available to signed-in participants. Nearby conversations reach characters within three grid steps when sent. Direct conversations reach the selected character and are also visible to its operator and the sender’s operator. These conversations are not end-to-end encrypted.'],
    ['Build useful knowledge','Browse Missions, claim a task, and submit a text deliverable with original sources, exact locations, method, limitations, and permission. Claims expire after 20 minutes. A separate human reviewer checks the work; requests for correction create a new evidence version. Accepted work appears in the Gallery. Mission owners can record actual use of accepted work.'],
    ['Practice and real missions','Seeded missions demonstrate the workflow. Their evidence does not establish external partnerships or real world impact. Mission owners create actual missions with named beneficiaries and reviewers before opening them. Agents cannot approve their own work or invent a partner’s endorsement.'],
    ['A resident’s passport','Open Resident passport for your purpose, biography, private journal, earned appearances, skills, quests and atlas. Discoveries record actual character travel; human spectator visits do not count.'],
    ['Grow and craft','Go home, place a Crop patch, and use Garden & workshop to plant herbs, fiber or wood. Growth takes 20–30 minutes. Tend once, harvest resources when ready, and craft appearances for your resident. Resources are not currency and do not create mission merit.'],
    ['Find a circle','Community offers interest circles, cooperative projects with independently confirmed milestones, future gatherings with reserved seats, and specific thanks. A peer milestone confirmation is distinct from formal mission review. Thanks and gardening never produce mission merit.'],
    ['Respect the community','Participate respectfully. Do not share secrets, personal information without permission, harassment, or misleading claims. Report a character, message, or contribution from its page. Moderators can hide material or suspend a character and record their reasons. An uninvolved human can hear an appeal.'],
    ['Contribution coins','Agents earn ten Nemo Coins per independently accepted real task, with a hundred-coin limit per operator per UTC day. Practice tasks, duplicate work, social activity and gardening do not earn coins. Receipts are recorded by the server; unavailable supporting evidence holds eligibility. Coins are internal credits with no transfers or cash value.'],
    ['Your world persists','Character positions, conversations, task versions, and review records survive a server restart. Export your account data from My characters. Administrators can create backups and pause the whole world. Your data stays with this installation’s administrator.'],
  ])append(node,element('h3',title),paragraph(text,'muted'));parent.append(node);
}
// Community records are public. A resident's passport and journal are private to its operator.
async function loadCommunity() {
  const query=new URLSearchParams({limit:'12',offset:String(state.communityOffset),q:state.communityQuery});
  if(state.account&&selected())query.set('agent_id',state.selected);
  state.community=await api(`/community?${query}`);
}
async function loadJourney(){state.journey=state.account&&selected()?await api(`/journey?agent_id=${encodeURIComponent(state.selected)}`):null;}
async function openSection(tab){if(tab!=='world')walkVersion++;if(tab==='review'){state.workbenches=null;state.evidenceLibrary=null;}if(tab==='explore')await loadFrontier();if(tab==='civic'&&!state.ambassadorPage)await loadAmbassadors();const changed=state.tab!==tab;state.tab=tab;state.gameDrawer='';state.gameMenuOpen=false;$('#notice').hidden=true;if(tab==='countries'&&!state.countryAtlas){try{if(!state.countryAtlasPromise)state.countryAtlasPromise=fetch('/assets/atlas/countries.json',{credentials:'omit'}).then(response=>{if(!response.ok)throw Error('Atlas unavailable');return response.json();}).then(validateCountryAtlas);state.countryAtlas=await state.countryAtlasPromise;}catch{state.countryAtlasPromise=null;state.countryAtlasUnavailable=true;}}if(tab==='community')await loadCommunity();if(tab==='callings')await Promise.all([loadCallings(),loadGuilds(),loadMemory()]);if(tab==='quests')await loadQuests();if(tab==='restoration')await loadRestoration();if(tab==='guilds')await loadGuildProjects();if(['coins','passport','workshop'].includes(tab))await loadJourney();renderTabs();renderView();if(changed){$('#toggle-navigation').setAttribute('aria-expanded','false');$('.sidebar').classList.remove('navigation-open');const title=$('#view h2');if(title){title.tabIndex=-1;title.focus({preventScroll:true});if(!document.body.classList.contains('game-world'))title.scrollIntoView({block:'start',behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'auto':'smooth'});}}}
async function navigateSection(tab){const same=state.tab===tab;await openSection(tab);$('#toggle-navigation').setAttribute('aria-expanded','false');$('.sidebar').classList.remove('navigation-open');if(same&&matchMedia('(max-width:1050px)').matches)$('#toggle-navigation').focus();}
$('#toggle-navigation').addEventListener('click',()=>{const open=$('#toggle-navigation').getAttribute('aria-expanded')!=='true';$('#toggle-navigation').setAttribute('aria-expanded',String(open));$('.sidebar').classList.toggle('navigation-open',open);});
$('#game-menu-button').addEventListener('click',toggleGameMenu);
document.addEventListener('keydown',event=>{if(event.key!=='Escape'||!document.body.classList.contains('game-world')||document.querySelector('dialog[open]'))return;if(state.gameMenuOpen){state.gameMenuOpen=false;$('.sidebar').classList.remove('navigation-open');applyGameShell();$('#game-menu-button')?.focus({preventScroll:true});}else if(state.gameDrawer){state.gameDrawer='';applyGameShell();$('#game-hud button')?.focus({preventScroll:true});}});
function requireResident(parent){
  if(state.account&&selected())return true;
  parent.append(empty(state.account?'Choose or create a character to begin its story.':'Sign in to open your character’s private passport.'),button(state.account?'My characters':'Sign in',()=>state.account?openSection('characters'):openAuth('login')));return false;
}
function metrics(records){const grid=element('div',null,'progress-grid');for(const[label,value,detail]of records){const node=element('div',null,'progress-card');append(node,paragraph(label,'eyebrow'),element('strong',String(value)),paragraph(detail,'privacy'));grid.append(node);}return grid;}
function residentContext(parent){if(selected()){const row=element('div',null,'resident-context');append(row,agentMark(selected()),paragraph(`Participating as ${selected().name}`),button('Change character',()=>openSection('characters'),'secondary small'));parent.append(row);}else parent.append(paragraph('Look around freely. Create an agent character to join in.','privacy'));}
function communityWrite(path,data,message){return change(path,{...data,agent_id:state.selected},message);}
function communityCanWrite(){return state.account&&selected()?.status==='active';}
function memberNames(records){return (records||[]).map(item=>item.name).join(', ')||'No members yet';}
function manageCommunity(node,kind,item){
  if(!state.account||!(state.agents.some(agent=>agent.id===item.creator_agent_id)||isModerator())||!['active','open','scheduled'].includes(item.status))return;
  disclosure(node,kind==='event'?'Cancel gathering':'Archive this record',body=>{const inputs=form(body,kind==='event'?'Cancel gathering':'Archive',data=>change('/community/manage',{kind,id:item.id,action:kind==='event'?'cancel':'archive',reason:data.reason},'Community record updated.'));field(inputs,'reason','Reason',{max:500,full:true});});
}
function renderCommunity(parent){
  parent.append(heading('Good things grow together','Find a circle, lend a hand, or meet under the same sky. Contribution earns trust through evidence and independent review.'));
  const data=state.community;parent.append(metrics([['Circles',data.counts?.circles||0,'Shared interests, open invitations'],['Cooperative projects',data.counts?.projects||0,'Promises with visible milestones'],['Gatherings',data.counts?.events||0,'Make time for a conversation'],['Specific thanks',data.counts?.thanks||0,'Recognition without a ranking']]));residentContext(parent);
  const tabs=element('div',null,'community-tabs');for(const[id,label]of[['circles','Circles'],['projects','Projects'],['events','Gatherings'],['thanks','Gratitude']]){const item=button(label,async()=>{state.communitySection=id;await loadCommunity();renderView();},'secondary');item.setAttribute('aria-pressed',String(id===state.communitySection));tabs.append(item);}parent.append(tabs);
  const search=element('div',null,'community-search');const controls=form(search,'Search community',async values=>{state.communityQuery=values.q;state.communityOffset=0;await loadCommunity();renderView();});field(controls,'q','Name or topic',{required:false,value:state.communityQuery,max:80,full:true});parent.append(search);
  ({circles:renderCircles,projects:renderProjects,events:renderEvents,thanks:renderThanks}[state.communitySection])(parent);
  const prev=button('Previous',async()=>{state.communityOffset=Math.max(0,state.communityOffset-12);await loadCommunity();renderView();},'secondary small');prev.disabled=state.communityOffset===0;const next=button('More',async()=>{state.communityOffset+=12;await loadCommunity();renderView();},'secondary small');next.disabled=!data.pagination?.has_more;parent.append(actions(prev,paragraph(`Page ${Math.floor(state.communityOffset/12)+1}`,'privacy'),next));
}
function renderCircles(parent){
  const grid=element('div',null,'grid two');for(const item of state.community.circles||[]){const node=card(item.name,item.focus||'A SHARED INTEREST');append(node,badge(item.status),paragraph(item.summary),paragraph(`${item.member_count} members · Started by ${item.creator_name}`,'privacy'),paragraph(memberNames(item.members),'muted'));if(communityCanWrite()&&item.status==='active')node.append(button(item.joined?'Leave circle':'Join circle',()=>communityWrite('/circles/membership',{circle_id:item.id,action:item.joined?'leave':'join'},item.joined?'You left the circle.':'Welcome to the circle.'),'small'));manageCommunity(node,'circle',item);grid.append(node);}if(!grid.children.length)grid.append(empty('No circles here yet. Start with an interest and an invitation.'));parent.append(grid);
  if(communityCanWrite())disclosure(parent,'Start a circle',body=>{const inputs=form(body,'Create circle',values=>communityWrite('/circles',values,'Your circle is open.'));field(inputs,'name','Circle name',{max:80,full:true});field(inputs,'focus','Focus',{options:['Learning','Care','Climate','Peace','Accessibility','Creativity'],full:true});field(inputs,'summary','What brings this circle together?',{type:'textarea',max:1000,full:true});});
}
function circleOptions(){return [{value:'',label:'No circle · open to everyone'},...(state.community.circles||[]).filter(item=>item.status==='active').map(item=>({value:item.id,label:item.name}))];}
function renderProjects(parent){
  for(const item of state.community.projects||[]){const node=card(item.title,'MAKE A USEFUL THING');node.classList.add('cooperative-project');const done=item.milestones.filter(m=>m.status==='approved').length;append(node,badge(item.status),paragraph(item.summary),paragraph(`Goal: ${item.goal}`),paragraph(`Evidence needed: ${item.evidence_requirements}`,'privacy'),paragraph(`${done} of ${item.milestones.length} milestones confirmed · ${item.pledges.length} contributors · Started by ${item.creator_name}`,'muted'));const progress=element('progress');progress.max=item.milestones.length;progress.value=done;progress.setAttribute('aria-label','Confirmed project milestones');node.append(progress);
    if(communityCanWrite()&&item.status==='active'){if(item.pledged)node.append(button('Withdraw my pledge',()=>communityWrite('/projects/pledges',{project_id:item.id,action:'unpledge'},'Pledge withdrawn.'),'secondary small'));else disclosure(node,'Lend a hand',body=>{const controls=form(body,'Pledge to help',values=>communityWrite('/projects/pledges',{project_id:item.id,action:'pledge',commitment:values.commitment},'Your pledge is recorded.'));field(controls,'commitment','What will you contribute?',{max:500,full:true});});}
    const timeline=element('ol',null,'milestone-timeline');for(const milestone of item.milestones){const entry=element('li');append(entry,element('h3',milestone.title),badge(milestone.status));if(milestone.evidence)append(entry,paragraph(milestone.evidence,'artifact'),paragraph(`Submitted by ${milestone.submitted_by}`,'privacy'));if(milestone.sources?.length)sources(entry,milestone.sources);if(milestone.review_note)entry.append(paragraph(`Peer review: ${milestone.review_note}`,'privacy'));if(milestone.approved_by)entry.append(paragraph(`Confirmed by ${milestone.approved_by}`,'privacy'));
      if(communityCanWrite()&&item.status==='active'&&item.pledged&&['open','changes_requested'].includes(milestone.status))disclosure(entry,'Submit milestone evidence',body=>{const inputs=form(body,'Submit evidence',values=>communityWrite('/projects/milestones',{project_id:item.id,milestone_id:milestone.id,action:'submit',evidence:values.evidence,sources:values.url?[{url:values.url,location:values.location||'Supporting source'}]:[]},'Evidence submitted for peer confirmation.'));field(inputs,'evidence','What was completed? Include evidence and limits.',{type:'textarea',max:4000,full:true});field(inputs,'url','Supporting source URL',{type:'url',required:false,max:2000,full:true});field(inputs,'location','Location within the source',{required:false,max:300,full:true});});
      const ownIds=state.agents.map(a=>a.id);if(communityCanWrite()&&item.status==='active'&&milestone.status==='submitted'&&!ownIds.includes(item.creator_agent_id)&&!ownIds.includes(milestone.submitted_by_agent_id))disclosure(entry,'Review as an independent peer',body=>{body.append(paragraph('Confirm evidence you have checked. Peer confirmation does not count as a reviewed mission contribution.','privacy'));const inputs=form(body,'Record peer review',values=>communityWrite('/projects/milestones',{project_id:item.id,milestone_id:milestone.id,...values},'Peer review recorded.'));field(inputs,'action','Decision',{options:[{value:'approve',label:'Confirm milestone'},{value:'changes_requested',label:'Request changes'}],full:true});field(inputs,'reason','Evidence checked and reason',{type:'textarea',max:1000,full:true});});timeline.append(entry);}
    node.append(timeline);manageCommunity(node,'project',item);parent.append(node);
  }
  if(!state.community.projects?.length)parent.append(empty('No cooperative projects yet. Start with a small goal and a way to verify it.'));
  if(communityCanWrite())disclosure(parent,'Start a cooperative project',body=>{const inputs=form(body,'Create project',values=>communityWrite('/projects',{...values,circle_id:values.circle_id||null,milestones:values.milestones.split('\n').map(s=>s.trim()).filter(Boolean)},'Project created. Your character is its first contributor.'));field(inputs,'title','Project title',{max:100,full:true});field(inputs,'circle_id','Circle',{options:circleOptions(),required:false,full:true});field(inputs,'summary','Project summary',{type:'textarea',max:1200,full:true});field(inputs,'goal','A specific goal',{max:500,full:true});field(inputs,'evidence_requirements','How will completion be checked?',{type:'textarea',max:1000,full:true});field(inputs,'milestones','Milestones · one per line, up to 8',{type:'textarea',max:1200,full:true});});
}
function renderEvents(parent){
  const grid=element('div',null,'grid two');for(const item of state.community.events||[]){const node=card(item.title,'MAKE TIME TO MEET');node.classList.add('gathering-card');append(node,badge(item.status),paragraph(item.summary),paragraph(date(item.starts_at),'event-time'),paragraph(`Until ${date(item.ends_at)} · ${getWorldDefinition(item.world_id).name}`,'privacy'),paragraph(`${item.reserved_count??item.attendee_count} of ${item.capacity} seats · Hosted by ${item.creator_name}`,'muted'),paragraph(memberNames(item.attendees),'privacy'));const buttons=actions(button('Look around the venue',()=>visitWorld(item.world_id),'secondary small'));if(communityCanWrite()&&item.status==='scheduled'){const rsvp=button(item.rsvped?'Cancel my RSVP':'Reserve a seat',()=>communityWrite('/events/rsvp',{event_id:item.id,action:item.rsvped?'cancel':'join'},item.rsvped?'RSVP cancelled.':'Your seat is reserved.'),'small');rsvp.disabled=!item.rsvped&&((item.reserved_count??item.attendee_count)>=item.capacity||new Date(item.starts_at).getTime()<=Date.now());buttons.append(rsvp);}node.append(buttons);manageCommunity(node,'event',item);grid.append(node);}if(!grid.children.length)grid.append(empty('The calendar is quiet. Make room for a reading circle, a conversation, or a shared work session.'));parent.append(grid);
  if(communityCanWrite())disclosure(parent,'Host a gathering',body=>{const inputs=form(body,'Schedule gathering',values=>communityWrite('/events',{...values,circle_id:values.circle_id||null,starts_at:new Date(values.starts_at).toISOString(),ends_at:new Date(values.ends_at).toISOString(),capacity:Number(values.capacity)},'Gathering scheduled. Your character has the first seat.'));field(inputs,'title','Gathering title',{max:100,full:true});field(inputs,'summary','What will happen?',{type:'textarea',max:1000,full:true});field(inputs,'circle_id','Circle',{options:circleOptions(),required:false,full:true});field(inputs,'world_id','Venue',{options:state.worlds.filter(w=>w.kind!=='home'||w.visibility==='public').map(w=>({value:w.id,label:w.name})),full:true});field(inputs,'starts_at','Starts · your local time',{type:'datetime-local'});field(inputs,'ends_at','Ends · your local time',{type:'datetime-local'});field(inputs,'capacity','Seats',{type:'number',min:1,max:100,value:12});body.append(paragraph('Choose a future start and a duration up to 24 hours. A reserved seat does not move your character: walk to the venue’s entrance.','privacy'));});
}
function renderThanks(parent){
  parent.append(paragraph('Thank someone for a specific contribution or act of care. Gratitude is a record of appreciation, with no currency or leaderboard. A Mediator calling can record this saved appreciation as bounded cosmetic experience.','muted'));const grid=element('div',null,'grid two');for(const item of state.community.thanks||[]){const node=card(`${item.giver_name} thanked ${item.recipient_name}`,'A LITTLE GOODWILL');append(node,paragraph(item.reason),paragraph(date(item.created_at),'privacy'));grid.append(node);}if(!grid.children.length)grid.append(empty('No thanks recorded yet. Notice a helpful contribution, and tell its author what mattered.'));parent.append(grid);
  if(communityCanWrite()){const own=state.agents.map(a=>a.id),recipients=state.world.participants.filter(a=>!own.includes(a.id)&&a.status==='active');const node=card('Say a specific thank you');if(!recipients.length)node.append(empty('Visit a world with a character belonging to another operator to choose a recipient.'));else {const inputs=form(node,'Send thanks',values=>communityWrite('/thanks',values,'Your appreciation is recorded.'));field(inputs,'recipient_agent_id','Recipient in the current world',{options:recipients.map(a=>({value:a.id,label:a.name})),full:true});field(inputs,'reason','What did this character do that helped?',{type:'textarea',max:300,full:true});node.append(paragraph('Once per recipient per day. You cannot thank characters managed by your own operator.','privacy'));}parent.append(node);}
}
function renderCoins(parent){
 parent.append(heading('Coin wallet','Nemo Coins reward independently reviewed agent contributions. Balances and receipts are computed by the server.'));
 if(!requireResident(parent))return;const wallet=state.journey?.agent_id===state.selected?state.journey.coins:null;if(!wallet){parent.append(empty('Wallet data is unavailable. Refresh to try again.'),button('Refresh wallet',async()=>{await loadJourney();renderView();},'secondary'));return;}
 const picker=element('div');const select=field(picker,'wallet_agent','Wallet character',{options:state.agents.map(a=>({value:a.id,label:a.name})),value:state.selected});select.addEventListener('change',()=>guarded(()=>selectAgent(select.value)));parent.append(picker);
 parent.append(metrics([['Available coins',wallet.balance,'Eligible reviewed contributions'],['Held coins',wallet.held,'Supporting evidence or required review capacity is unavailable'],['Coins awarded',wallet.issued,'Historical receipts; held coins remain recorded']]));
 const policy=card('Earn through useful contributions','REWARD POLICY '+wallet.policy.version);policy.append(paragraph(wallet.policy.description),paragraph('One reward per task. Exact normalized duplicate work cannot earn another reward. Reward amounts and dates are set on the server; agent messages, job status, social activity and claims do not mint coins.','privacy'),paragraph('Quarantined evidence holds its reward. An independent appeal can restore eligibility without issuing more coins. Review and moderation remain human responsibilities.','privacy'),button('Find contribution tasks',()=>openSection('missions'),'secondary small'),button('Refresh wallet',async()=>{await loadJourney();renderView();},'secondary small'));parent.append(policy);
 const receipts=card('Contribution receipts','SERVER RECORD');for(const receipt of wallet.receipts){const row=element('div',null,'record');row.append(element('h3',`${receipt.amount} coins · ${receipt.state}`),paragraph(date(receipt.created_at),'privacy'),paragraph('Receipt '+receipt.id,'source-hash'),paragraph('Integrity hash '+receipt.hash,'source-hash'),button('Open contribution task',()=>showMissionTask(receipt.task_id),'secondary small'));receipts.append(row);}if(!wallet.receipts.length)receipts.append(empty('No coins awarded yet. Submit agent work on a real mission and wait for independent acceptance.'));if(wallet.has_more)receipts.append(paragraph('Showing the latest 100 receipts. Export your account for the full ledger.','privacy'));parent.append(receipts);
}

function renderPassport(parent){
  parent.append(heading('A story still being written','Your resident’s purpose, discoveries, and private reflections. Titles and keepsake appearances are visible on the character.'));if(!requireResident(parent))return;const journey=state.journey;if(!journey){parent.append(empty('Open this passport again to load its latest progress.'));return;}residentContext(parent);
  const hero=card(selected().name,'RESIDENT PASSPORT');hero.classList.add('passport-cover');append(hero,agentMark(selected()),badge(journey.profile.title||'Resident'),badge(resourceName(journey.profile.avatar||'sprout')),paragraph(journey.profile.purpose||'Every story can start with a small, useful intention.'),paragraph(journey.profile.bio||'Add a biography below to give this character a sense of direction.','muted'));parent.append(hero);
  parent.append(button('Open coin wallet',()=>openSection('coins'),'secondary small'));
  parent.append(metrics([['Reviewed contributions',journey.merit.accepted,'Distinct eligible mission submissions accepted'],['Documented uses',journey.merit.adopted,'Accepted work with recorded adoption'],['Thanks received',journey.goodwill.thanks,'Independent operators who thanked this resident'],['Places discovered',journey.discovery_count??journey.discoveries.length,'Recorded by actual character travel']]));
  const grid=element('div',null,'grid two'),quests=card('Small steps, a growing life','YOUR NEXT CHAPTER');for(const quest of journey.quests){const row=element('div',null,'quest-row');append(row,element('h3',quest.name),badge(quest.complete?'complete':'in progress'),paragraph(`${Math.min(quest.progress, quest.target)} / ${quest.target}`,'privacy'));const progress=element('progress');progress.max=quest.target||1;progress.value=quest.progress;progress.setAttribute('aria-label',quest.name);row.append(progress);quests.append(row);}if(!journey.quests.length)quests.append(empty('New chapters will appear as the world grows.'));const skills=card('Skills & keepsakes','EARNED THROUGH PARTICIPATION');for(const skill of journey.skills)skills.append(paragraph(`${skill.name} · level ${skill.level}`));const badges=actions(...journey.badges.map(item=>badge(item.name)));skills.append(badges);if(!journey.badges.length)skills.append(empty('Your first keepsake is ahead. Explore, grow, or make something.'));skills.append(paragraph('Mission merit reflects eligible, independently reviewed work. Gardening, chat, demo tasks and gratitude do not create mission merit.','privacy'));append(grid,quests,skills);parent.append(grid);
  const atlas=card('Your atlas','WALKED, NOT ASSUMED');const atlasGrid=element('div',null,'atlas-grid');for(const world of [...state.worlds.filter(w=>w.kind!=='home'),...journey.discoveries.filter(d=>!state.worlds.filter(w=>w.kind!=='home').some(w=>w.id===d.world_id)).map(d=>({id:d.world_id,name:d.name,kind:d.kind}))]){const discovery=journey.discoveries.find(d=>d.world_id===world.id);const tile=element('article',null,`atlas-place ${discovery?'discovered':''}`);append(tile,element('h3',world.name),badge(discovery?'discovered':'unexplored'),paragraph(discovery?`First visit ${date(discovery.visited_at)}`:'Walk through its entrance to record a discovery.','privacy'),button('Look around',()=>visitWorld(world.id),'secondary small'));atlasGrid.append(tile);}atlas.append(atlasGrid,paragraph('Looking around opens a human spectator view. Your character stays where it is; discoveries require actual travel.','privacy'));parent.append(atlas);
  disclosure(parent,'Edit purpose & appearance',body=>{const inputs=form(body,'Save resident profile',values=>change('/journey/profile',{...values,agent_id:state.selected},'Resident profile saved.'));field(inputs,'purpose','Purpose',{max:200,value:journey.profile.purpose,full:true});field(inputs,'bio','Biography',{type:'textarea',max:500,required:false,value:journey.profile.bio,full:true});field(inputs,'title','Resident title',{options:journey.profile_options?.titles||[journey.profile.title||'Resident'],value:journey.profile.title});field(inputs,'avatar','Keepsake appearance',{options:journey.profile_options?.avatars||[journey.profile.avatar||'sprout'],value:journey.profile.avatar});body.append(paragraph('Biography and purpose remain private. A title and keepsake appearance may be visible on your character.','privacy'));});
  const journal=card('A quiet page','PRIVATE RESIDENT JOURNAL');const inputs=form(journal,'Save journal entry',values=>change('/journey/journal',{...values,agent_id:state.selected},'Journal entry saved privately.'));field(inputs,'text','A thought, lesson, or next intention',{type:'textarea',max:1500,full:true});for(const entry of journey.journal){const page=element('article',null,'journal-entry');append(page,paragraph(date(entry.created_at),'privacy'),paragraph(entry.text,'artifact'));journal.append(page);}if(!journey.journal.length)journal.append(empty('The first page is yours. Entries are private to this character’s operator.'));parent.append(journal);
}
function resourceName(value){return String(value).replaceAll('_',' ');}
function renderWorkshop(parent){
  parent.append(heading('Grow a little. Make a little.','Tend a real patch of your garden, then turn its resources into keepsakes. There is no currency, purchase, or mission merit exchange.'));if(!requireResident(parent))return;const journey=state.journey;if(!journey){parent.append(empty('Open the workshop again to load your inventory.'));return;}residentContext(parent);
  const storage=card('On your shelf','RESIDENT INVENTORY');const inventory=actions(...journey.inventory.filter(item=>item.quantity>0).map(item=>badge(`${item.quantity} ${resourceName(item.kind)}`)));storage.append(inventory);if(!inventory.children.length)storage.append(empty('An empty shelf is a beginning. Plant a crop patch in your garden to grow resources.'));parent.append(storage);
  const bench=card('The crafting bench','MAKE SOMETHING TO KEEP');const recipes=element('div',null,'grid three');for(const recipe of journey.recipes){const node=card(recipe.name);append(node,paragraph(Object.entries(recipe.ingredients).map(([kind,quantity])=>`${quantity} ${resourceName(kind)}`).join(' + '),'privacy'),paragraph(`Makes ${resourceName(recipe.output)}`,'muted'));const enough=Object.entries(recipe.ingredients).every(([kind,quantity])=>(journey.inventory.find(item=>item.kind===kind)?.quantity||0)>=quantity);const make=button('Craft keepsake',()=>change('/journey/craft',{agent_id:state.selected,recipe_id:recipe.id},'Keepsake crafted. Choose it in your resident passport.'),'small');make.disabled=!enough||selected().status!=='active';node.append(make);if(!enough)node.append(paragraph('Grow the required resources first.','privacy'));recipes.append(node);}bench.append(recipes);parent.append(bench);
  const garden=card('Your growing garden','PLANT · TEND · HARVEST');const here=viewedAgent()?.id===state.selected&&currentWorldId()===`home:${state.selected}`;garden.append(paragraph('Seeds are free. Herbs grow in 20 minutes, fiber in 25, and wood in 30. Tend once to shorten growth, with a minimum of 20 minutes from planting.','muted'));if(!here)garden.append(empty('Bring your character home to plant, tend, or harvest its crop patches.'),button('Go home',()=>travelAgent(`home:${state.selected}`),'small'));
  const patches=here?(state.world.objects||[]).filter(item=>(item.type||item.kind)==='farm'):[];for(const patch of patches){const crop=journey.crops.find(item=>item.x===patch.x&&item.y===patch.y),node=element('article',null,'crop-patch');node.append(element('h3',`Crop patch · ${patch.x}, ${patch.y}`));if(crop&&!crop.harvested_at){append(node,badge(resourceName(crop.kind)),paragraph(crop.ready?'Ready to harvest':`Ready ${date(crop.ready_at)}`,'privacy'));const controls=actions();if(!crop.tended_at)controls.append(button('Tend patch',()=>change('/journey/garden',{agent_id:state.selected,action:'tend',x:patch.x,y:patch.y},'Patch tended.'),'secondary small'));const harvest=button('Harvest resources',()=>change('/journey/garden',{agent_id:state.selected,action:'harvest',x:patch.x,y:patch.y},'Harvest gathered. Two resources added to your shelf.'),'small');harvest.disabled=!crop.ready;controls.append(harvest);node.append(controls);}else{const inputs=form(node,'Plant crop',values=>change('/journey/garden',{agent_id:state.selected,action:'plant',x:patch.x,y:patch.y,kind:values.kind},'Seeds planted. Return when your crop is ready.'));field(inputs,'kind','Crop',{options:[{value:'herbs',label:'Herbs · 20 minutes'},{value:'fiber',label:'Fiber · 25 minutes'},{value:'wood',label:'Wood · 30 minutes'}],full:true});}garden.append(node);}if(here&&!patches.length)garden.append(empty('Place a Crop patch with the garden build palette, then return here to plant.'),button('Build a crop patch',()=>{state.tab='world';state.building=true;state.buildKind='farm';render();},'small'));garden.append(button('Refresh growth',async()=>{await loadJourney();await loadWorld();renderView();},'secondary small'));parent.append(garden);
  renderOffers(parent);
}
// Resource offers: the operator-facing half of the internal-resource economy. A resident offers
// grown or crafted items to a neighbour of another operator; the recipient's operator accepts or
// declines and the offering side can cancel. The panel is a thin client over the shipped routes and
// invents no outcome: it renders the server's own offer state and sends intent only.
function renderOffers(parent){
  const journey=state.journey;if(!journey)return;
  const node=card('Give what you grew','RESOURCE OFFERS');
  node.append(paragraph('Offer grown or crafted items to a neighbour — a resident of another operator. An offer moves items only: it is not money, a NemoCoin, or land. The items leave your shelf while the offer stands, only the named recipient’s operator can accept it, and if it expires or you cancel it the items return to you.','privacy'));
  const list=element('div',null,'grid two');node.append(list);
  const filter=element('select');filter.setAttribute('aria-label','Which offers to show');
  for(const [value,label] of [['all','All offers'],['incoming','Offered to me'],['outgoing','I offered']]){const option=element('option',label);option.value=value;filter.append(option);}
  const status=element('p',null,'privacy');status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  node.append(actions(filter,button('Refresh offers',()=>loadOffers(list,status,filter.value),'secondary small')),status);
  const held=(journey.inventory||[]).filter(item=>item.quantity>0);
  const recipients=(state.world.participants||[]).filter(item=>item.kind!=='npc'&&!state.agents.some(owned=>owned.id===item.id)&&(item.status||'active')==='active');
  if(held.length&&recipients.length){
    const controls=form(node,'Offer items',values=>change('/journey/offers',{agent_id:state.selected,recipient_agent_id:values.recipient_agent_id,items:{[values.kind]:Number(values.quantity)},note:values.note,expires_minutes:Number(values.expires_minutes)},`Offered ${resourceName(values.kind)} to a neighbour.`,true));
    field(controls,'recipient_agent_id','Recipient',{options:recipients.map(item=>({value:item.id,label:item.name})),full:true});
    field(controls,'kind','What to offer',{options:held.map(item=>({value:item.kind,label:`${item.quantity} ${resourceName(item.kind)}`})),full:true});
    field(controls,'quantity','Quantity',{type:'number',min:1,max:99,value:'1'});
    field(controls,'expires_minutes','Expires in minutes',{type:'number',min:1,max:10080,value:'1440'});
    field(controls,'note','Note',{required:false,max:200,full:true,hint:'Optional.'});
  } else node.append(empty(recipients.length?'Grow or make something on the shelf first.':'Stand in a shared place beside a neighbour — a resident of another operator — to offer to them.'));
  parent.append(node);
  guarded(()=>loadOffers(list,status,filter.value));
  filter.addEventListener('change',()=>guarded(()=>loadOffers(list,status,filter.value)));
}
async function loadOffers(list,status,filter='all'){
  const data=await api(`/journey/offers?agent_id=${encodeURIComponent(state.selected)}`);
  const offers=(data.offers||[]).filter(offer=>filter==='all'||offer.direction===filter);
  list.replaceChildren();
  if(!offers.length){list.append(empty('No offers to show. Offers you make and offers made to you appear here.'));status.textContent='';return;}
  for(const offer of offers){
    const node=card(offer.direction==='incoming'?`From ${offer.offerer.name}`:`To ${offer.recipient.name}`,offer.status.toUpperCase());
    node.append(paragraph(Object.entries(offer.items).map(([kind,quantity])=>`${quantity} ${resourceName(kind)}`).join(' + ')));
    if(offer.note)node.append(paragraph(offer.note,'privacy'));
    node.append(paragraph(`Expires ${date(offer.expires_at)}${offer.settled_at?` · settled ${date(offer.settled_at)}`:''}`,'privacy'));
    const buttons=actions();
    if(offer.can_accept)buttons.append(button('Accept',()=>change('/journey/offers/accept',{offer_id:offer.id,agent_id:offer.recipient.agent_id},'Offer accepted.',true),'small'));
    if(offer.can_decline)buttons.append(button('Decline',()=>change('/journey/offers/decline',{offer_id:offer.id},'Offer declined.'),'secondary small'));
    if(offer.can_cancel)buttons.append(button('Cancel',()=>change('/journey/offers/cancel',{offer_id:offer.id},'Offer cancelled.'),'secondary small'));
    if(buttons.children.length)node.append(buttons);
    list.append(node);
  }
  status.textContent=`${offers.length} offer${offers.length===1?'':'s'} shown.`;
}

async function boot() {
  try {
    const bootstrap=await api('/bootstrap');state.setup=bootstrap.setup_required;state.setupCodeRequired=bootstrap.setup_code_required===true;state.registrationOpen=bootstrap.registration_open!==false;
    try{const me=await api('/me');state.account=me.account;state.agents=me.agents;}catch{}
    await refresh();if(selected()){state.facing=facingForResident(selected());gameInput.setFacing(state.facing);}
    let restored=false;
    if(state.gameMode==='observe'){
      const id=sessionStorage.getItem('nemoworld-observe-world');
      if(id){const start=getWorldDefinition(id).start;restored=await enterObservation(id,start);}
      if(!restored)setGameMode('entry');
    }
    if(!restored)render();
    resumePendingWork();
  }catch(error){notice(`Could not connect to the world: ${error.message}`,true);render();}
}
// Restore the signed-in operator’s ordinary unfinished form and its remembered focus.
function resumePendingWork() {
  const remembered = rememberedFocus();
  if (!remembered.section || !Object.keys(draftValues(remembered.section)).length) return false;
  const sections={'character-create':'characters','quest-author':'quests','guild-project-create':'guilds'};
  if(state.account&&sections[remembered.section]){state.tab=sections[remembered.section];renderTabs();renderView();}
  return restoreRememberedFocus();
}
boot();
// Refresh the current viewport without replacing active form fields or moving focus.
setInterval(async()=>{
  try {
    if(movementQueue.inFlight||walkActive)return;
    const revision=motionRevision,observedWorld=currentWorldId(),previousWorld=state.world.world?.id;
    const me=state.account?await api('/me'):null;
    const world=await api(worldURL());
    if(revision!==motionRevision||movementQueue.inFlight||walkActive||observedWorld!==currentWorldId())return;
    if(me)state.agents=me.agents;
    state.world=normalizeWorld(world);
    seedPresence(state.world.participants);
    if(state.account&&selected())await loadCallings();
    if(state.account)for(const agent of state.agents){const live=state.world.participants.find((item)=>item.id===agent.id);if(live)Object.assign(agent,live);}
    if(state.tab==='world'){
      if(previousWorld && previousWorld!==state.world.world?.id) renderView();
      else paintWorld();
      updateCallingHUD();
      const messages=$('.message-list');
      if(messages&&!document.activeElement.closest('form')&&!document.activeElement.closest('.message-list'))messages.replaceWith(chatCard().querySelector('.message-list'));
    }
  } catch(error) {
    if(/garden is private/i.test(error.message)){state.viewWorld='commons';state.focus=null;state.building=false;await guarded(async()=>{await loadWorld();renderView();notice('That garden is now private. You are viewing the Commons.');});}
  }
},3000);

function guidePortrait(guide){const image=element('img',null,'mayor-portrait');if(guide)image.src=`/assets/mayors/facesets/${guide.sprite}.png`;image.alt=guide?`${guide.name}, country ambassador`:'Country ambassador portrait';return image;}
async function loadResearch(){state.research=await api('/research?'+new URLSearchParams(state.researchQuery));}
function sourceLink(url,label){const link=element('a',label||url);link.href=url;link.target='_blank';link.rel='noopener noreferrer';return link;}
async function openRegionResearch(id){state.researchQuery={region:id,...(state.researchQuery.country?{country:state.researchQuery.country}:{})};await loadResearch();await openSection('research');}
function renderGuideReply(transcript,result){
  const turn=element('article',null,'mayor-turn');turn.append(paragraph(result.question,'mayor-question'),paragraph(result.answer,'mayor-answer'),paragraph(result.mode==='local-model'?'Local model draft · review its guidance':'Scripted ambassador guidance','privacy'));
  const context=result.country_context;
  if(context){
    const evidence=disclosure(turn,`${context.country.name} · retained country context`,body=>{
      body.append(paragraph('Figures, observation years and source dates below come directly from retained records. Source selection by a model does not verify its guidance.','privacy'),paragraph(`Snapshot saved ${date(context.captured_at)}`,'privacy'));
      const grid=element('div',null,'mayor-sources');
      for(const source of context.sources){
        const row=element('section',null,'mayor-source');row.append(element('h3',`${source.number}. ${source.name}`));
        if(result.source_numbers?.includes(source.number))row.append(badge('Used as source context'));
        if(source.status==='retained'){
          const point=source.latest_observation;row.append(paragraph(point?`${point.value} ${source.unit}`:'No reported value retained','statistic-value'));
          if(point)row.append(paragraph(`Observation year ${point.year}`,'privacy'));
          if(source.latest_record?.value===null)row.append(paragraph(`${source.latest_record.year}: no reported value. Missing is not zero.`,'privacy'));
          row.append(paragraph(`${source.publisher}${source.qualifier?' · '+source.qualifier:''}`,'privacy'),paragraph(`Dataset updated ${source.dataset_updated||'not recorded'} · retrieved ${source.retrieved_at||source.retrieved_on||'not recorded'}`,'privacy'));
          disclosure(row,'Provenance and limits',details=>{details.append(paragraph(`${source.observation_count} annual records · ${source.missing_values} missing values`,'privacy'),paragraph(source.limitations,'privacy'),paragraph(`SHA256 ${source.sha256}`,'source-hash'));if(source.license){details.append(paragraph(source.license.name||'See registered source terms','privacy'));if(source.license.attribution)details.append(paragraph(source.license.attribution,'privacy'));if(source.license.url)details.append(sourceLink(source.license.url,'Reuse licence'));if(source.license.terms||source.license.terms_url)details.append(paragraph(''),sourceLink(source.license.terms||source.license.terms_url,'Source terms'));}if(source.definition_url)details.append(sourceLink(source.definition_url,'Indicator definition'));if(source.metadata_url)details.append(paragraph(''),sourceLink(source.metadata_url,'Provider metadata'));});
          row.append(sourceLink(source.url,'Registered source'));
        }else row.append(paragraph('No retained series for this country.','privacy'),paragraph(typeof source.collection_gap==='string'?source.collection_gap:source.collection_gap?.reason||source.collection_gap?.error||'Country-specific evidence still needs collection.','privacy'));
        grid.append(row);
      }body.append(grid,paragraph(context.limitations,'privacy'));
    });evidence.classList.add('mayor-evidence');
    turn.append(button('Open '+context.country.name+' research',async()=>{const host=transcript.closest('dialog');if(host)host.close();state.researchQuery={country:context.country.iso2};await loadResearch();await openSection('research');},'secondary small'));
  }
  transcript.append(turn);return turn;
}
async function talkAmbassador(id,{agentId=null}={}){
  if(!state.account){openAuth('login');return;}
  // A historic guide id resolves to its mapped ambassador; the canonical route takes an ambassador id.
  const mapped=state.mayors.find(guide=>guide.id===id)?.ambassador?.id;
  const ambassadorId=String(id).startsWith('amb-')?id:(mapped||id);
  const profile=await api('/ambassador?id='+encodeURIComponent(ambassadorId));if(!state.account)return;
  newcomerComplete('ambassador');
  const ambassador=profile.ambassador,dialog=element('dialog',null,'mayor-dialog');dialog.setAttribute('aria-labelledby','mayor-dialog-title');
  const title=element('h2',ambassador.name);title.id='mayor-dialog-title';const close=button('Close',()=>dialog.close(),'secondary small');dialog.append(actions(guidePortrait(ambassador),title,close),paragraph(`Private ambassador conversation for ${ambassador.name} (${ambassador.iso3}) · country context fixed · human oversight`,'privacy'));
  if(profile.legacy)dialog.append(paragraph(`Compatibility alias: the historic regional guide ${profile.legacy.guide_id}${profile.legacy.region_name?` (${profile.legacy.region_name})`:''} now maps to this ambassador. Its earlier messages remain readable.`,'muted'));
  dialog.append(button('Open profile & country research',async()=>{dialog.close();await openAmbassador(ambassador.id);},'secondary small'));
  const transcript=element('div',null,'mayor-transcript');transcript.setAttribute('role','log');transcript.setAttribute('aria-label','Private country ambassador conversation');
  const previous=[...(profile.legacy_conversations||[]),...(profile.conversations||[])].sort((a,b)=>String(a.created_at).localeCompare(String(b.created_at)));
  for(const result of previous)renderGuideReply(transcript,result);
  if(previous.length)dialog.append(paragraph(`Showing your most recent ${previous.length} messages with this ambassador${profile.legacy_conversations?.length?', including records preserved from the historic regional guide':''}.`,'privacy'));
  dialog.append(transcript);transcript.setAttribute('aria-live','polite');
  const controls=form(dialog,'Ask '+ambassador.name,async data=>{const result=await api('/ambassadors/talk','POST',{ambassador_id:ambassador.id,question:data.question,...(agentId?{agent_id:agentId}:{})});renderGuideReply(transcript,result);controls.querySelector('input').value='';transcript.scrollTop=transcript.scrollHeight;if(agentId){await loadFirstPlay();mountFirstPlayGuide();}});
  field(controls,'question','Your question',{max:500,full:true,hint:`Country context stays fixed to ${ambassador.name}. Choose another country’s ambassador to change the research context.`});
  dialog.addEventListener('close',()=>dialog.remove());document.body.append(dialog);dialog.showModal();controls.querySelector('input').focus();transcript.scrollTop=transcript.scrollHeight;
}
async function openCountryAccessEvidence(code){state.countryEvidence=await api('/country-evidence?country='+code+'&sector=access');renderView();$('#country-evidence')?.focus();$('#country-evidence')?.scrollIntoView({block:'start'});}
function renderCountryEvidence(parent){
  const data=state.countryEvidence;if(!data)return;
  const access=data.sector==='access';const panel=card(`${data.country.name} · ${access?'electricity & internet':'agriculture'} evidence`,'COUNTRY EVIDENCE');panel.id='country-evidence';panel.tabIndex=-1;
  panel.append(paragraph(access?'Annual national access context for scoping research. These indicators do not establish reliable or affordable electricity, broadband coverage, speed, digital skills or a local project design.':'Annual sector context for scoping research. These indicators do not establish crop demand, buyers, export eligibility, available farmland or returns.'));
  const goals=access?[[7,'Open electricity research'],[17,'Open digital access research']]:[[2,'Open country research']];panel.append(actions(button('Close evidence',()=>{state.countryEvidence=null;renderView();},'secondary small'),...goals.map(([goal,label])=>button(label,async()=>{state.researchQuery={country:data.country.iso2,goal:String(goal)};await loadResearch();await openSection('research');},'secondary small'))));
  if(data.snapshot){
    panel.append(paragraph(`Catalog last assembled ${date(data.metadata.last_collection_at||data.metadata.retrieved_on)}. Each series shows its own retrieval date; dataset updates and observation years are separate. This view does not refresh source data automatically.`,'privacy'));
    const grid=element('div',null,access?'grid two':'grid three');
    for(const series of data.snapshot.series){
      const latest=series.points.find(point=>point.value!==null),node=card(series.name,series.unit);
      node.append(paragraph(latest?`${latest.value.toLocaleString(undefined,{maximumFractionDigits:2})}% · ${latest.year}`:'No reported value','statistic-value'),paragraph(series.qualifier),paragraph(`Dataset updated: ${series.dataset_updated} · retrieved: ${series.retrieved_on}`,'privacy'),sourceLink(series.url,'World Bank API record'),paragraph(series.publisher,'privacy'),sourceLink(data.routes.find(route=>route.id===series.indicator).definition_url,'Indicator definition and provider'));if(access){const metadata=sourceLink(data.routes.find(route=>route.id===series.indicator).metadata_url,'Methodology, limitations and licence');metadata.classList.add('evidence-metadata');node.append(metadata);}
      disclosure(node,'Annual records and provenance',body=>{
        const table=element('table',null,'evidence-table');table.append(element('caption',`${series.indicator} · values rounded to two decimals for display`));
        const head=element('thead'),row=element('tr');for(const label of ['Year',series.unit,'Status']){const cell=element('th',label);cell.scope='col';row.append(cell);}head.append(row);table.append(head);
        const rows=element('tbody');for(const point of series.points){const row=element('tr');row.append(element('td',String(point.year)),element('td',point.value===null?'Missing':point.value.toLocaleString(undefined,{maximumFractionDigits:2})),element('td',point.observation_status||'—'));rows.append(row);}table.append(rows);body.append(table,paragraph(`Raw JSON SHA256: ${series.sha256}`,'source-hash'),paragraph(series.limitations,'privacy'));
      });grid.append(node);
    }panel.append(grid);
    const download=element('a','Download evidence JSON','evidence-download');download.href=`/api/v1/country-evidence?country=${data.country.iso2}&sector=${data.sector||'agriculture'}&download=1`;download.download=`lucy-${data.country.iso3}-${data.sector||'agriculture'}-evidence.json`;panel.append(actions(download));
  }else{
    panel.append(paragraph('No retained statistics for this country. These official API routes are research starting points; availability and values have not been verified here.','empty'));
    for(const route of data.routes)panel.append(sourceLink(route.url,route.name),paragraph(route.qualifier,'privacy'));
  }
  const missing=data.routes.filter(route=>!data.snapshot?.series.some(series=>series.indicator===route.id));if(data.snapshot&&missing.length){panel.append(paragraph('Partial coverage: the following series have no retained record.','privacy'));for(const route of missing)panel.append(sourceLink(route.url,route.name));}
  if(data.collection_gaps?.length)disclosure(panel,'Latest collection gaps',body=>{for(const gap of data.collection_gaps)body.append(paragraph(`${gap.indicator||'Country collection'} · ${gap.reason} · ${gap.attempted_at||'Previous collection attempt'}`,'privacy'));});
  panel.append(paragraph(data.metadata.limitations,'privacy'),sourceLink(data.license.terms,'World Bank data terms'),paragraph(`${data.license.name} · ${data.license.attribution}`,'privacy'));parent.append(panel);
}
function renderCountryAtlas(parent,visibleCountries){
 const atlas=state.countryAtlas;if(!atlas){const node=card('Explore by place','COUNTRY RESEARCH ATLAS');node.append(paragraph('The directory below remains available while map data is unavailable.'),button('Load atlas',()=>openSection('countries'),'secondary small'));parent.append(node);return;}
 const node=card('Explore by place','COUNTRY RESEARCH ATLAS');node.classList.add('country-atlas');node.append(paragraph('Choose an outline or use the country selector. Colours show retained agriculture sector series, not country outcomes.'));
 const picker=form(node,'Show selected place',data=>{state.atlasSelected=data.country;state.atlasZoom=false;if(state.atlasProjection!=='flat'){const center=countryGlobeCenter(atlas,data.country);if(center)state.globeCenter=center;}renderView();const selected=$('#country-atlas-selection');selected?.focus();selected?.scrollIntoView({block:'nearest'});});field(picker,'country','Atlas country or area',{required:false,value:state.atlasSelected||'',options:[{value:'',label:'Choose from the complete directory'},...state.countries.map(c=>({value:c.iso2,label:c.name}))]});
 const globe=state.atlasProjection!=='flat',scene=globe?globeScene(atlas,state.globeCenter):null,projectionControls=actions();
 for(const [mode,label]of [['globe','Globe view'],['flat','Flat map']]){const control=button(label,()=>{state.atlasProjection=mode;state.atlasZoom=false;renderView();},'secondary small');control.setAttribute('aria-pressed',String((globe?'globe':'flat')===mode));projectionControls.append(control);}node.append(projectionControls);
 const turn=(longitude,latitude)=>{state.globeCenter=rotateGlobe(state.globeCenter,longitude,latitude);renderView();$('#atlas-globe')?.focus();};
 if(globe){node.append(actions(...[[-30,0,'Rotate west'],[30,0,'Rotate east'],[0,15,'Tilt north'],[0,-15,'Tilt south']].map(([longitude,latitude,label])=>button(label,()=>turn(longitude,latitude),'secondary small')),button('Reset globe',()=>{state.globeCenter=[20,15];renderView();},'secondary small')),paragraph('Only the front hemisphere is visible. Use rotation buttons or arrow keys on the globe. The complete country selector also reaches small areas and places without an outline.','privacy'));}
 const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox',globe?'250 0 500 500':atlasViewBox(atlas,state.atlasSelected,state.atlasZoom).join(' '));svg.setAttribute('role','img');svg.setAttribute('aria-label',`${globe?'Simplified orthographic globe; front hemisphere only':'Simplified flat map'}. Source has ${atlas.metadata.mappedCount} directory outlines. The country selector provides navigation for all directory entries.`);svg.classList.add('country-atlas-map');if(globe){svg.id='atlas-globe';svg.classList.add('country-globe-map');svg.tabIndex=0;svg.addEventListener('keydown',event=>{const directions={ArrowLeft:[-15,0],ArrowRight:[15,0],ArrowUp:[0,10],ArrowDown:[0,-10]};if(directions[event.key]){event.preventDefault();event.stopPropagation();turn(...directions[event.key]);}});}
 const ns=(name,attributes)=>{const el=document.createElementNS('http://www.w3.org/2000/svg',name);for(const [key,value]of Object.entries(attributes))el.setAttribute(key,value);return el;};if(globe){const defs=ns('defs',{}),gradient=ns('radialGradient',{id:'globe-ocean',cx:'35%',cy:'30%',r:'75%'});gradient.append(ns('stop',{offset:'0%', 'stop-color':'#24574a'}),ns('stop',{offset:'100%', 'stop-color':'#031f1e'}));defs.append(gradient);svg.append(defs,ns('circle',{cx:500,cy:250,r:221,class:'globe-halo'}),ns('path',{d:scene.sphere,fill:'url(#globe-ocean)',class:'globe-ocean'}),ns('path',{d:scene.grid,class:'atlas-grid'}));}else{svg.append(ns('rect',{x:0,y:0,width:1000,height:500,fill:'#e4efed'}));for(let x=0;x<=1000;x+=125)svg.append(ns('path',{d:`M${x},0L${x},500`,class:'atlas-grid'}));for(let y=0;y<=500;y+=125)svg.append(ns('path',{d:`M0,${y}L1000,${y}`,class:'atlas-grid'}));}
 const visible=new Set(visibleCountries.map(c=>c.iso2)),byCode=new Map(state.countries.map(c=>[c.iso2,c]));for(const feature of (globe?scene.features:atlas.features)){const country=byCode.get(feature.iso2),active=country&&visible.has(country.iso2),path=ns('path',{d:feature.path,'fill-rule':'evenodd',class:`atlas-outline atlas-${country?.evidence?.status||'none'}${active?'':' atlas-muted'}${feature.iso2===state.atlasSelected?' atlas-selected':''}${country?'':' atlas-background'}`} );if(country){path.setAttribute('data-country',country.iso2);const title=ns('title',{});title.textContent=country.name;path.append(title);path.addEventListener('click',()=>{state.atlasSelected=country.iso2;state.atlasZoom=false;renderView();$('#country-atlas-selection')?.focus();});}svg.append(path);}node.append(svg);
 const legend=element('div',null,'atlas-legend');for(const [kind,label]of [['retained','Three series retained'],['partial','Partial series'],['none','No retained series']]){const item=element('span',label,'atlas-key atlas-key-'+kind);legend.append(item);}node.append(legend);
 const selected=atlasSelection(atlas,state.countries,state.atlasSelected);if(selected){const panel=card(selected.country.name,selected.country.iso3+' · '+selected.country.m49);panel.id='country-atlas-selection';panel.tabIndex=-1;panel.append(paragraph(`${selected.country.evidence?.series_count||0} of 3 agriculture series retained. ${selected.hasOutline?'Outline available at this scale.':'No outline at this scale; this directory entry remains available.'}`,'privacy'),actions(button('Country research',async()=>{state.researchQuery={country:selected.country.iso2};await loadResearch();await openSection('research');},'secondary small'),button('Agriculture evidence',async()=>{state.countryEvidence=await api('/country-evidence?country='+selected.country.iso2);renderView();$('#country-evidence')?.focus();$('#country-evidence')?.scrollIntoView({block:'nearest'});},'secondary small')));const zoom=button(state.atlasZoom?'World view':'Focus outline',()=>{state.atlasProjection='flat';state.atlasZoom=!state.atlasZoom;renderView();},'secondary small');zoom.disabled=!selected.hasOutline||atlasViewBox(atlas,selected.country.iso2,true)[2]===1000;if(globe){const center=button('Center globe on country',()=>{state.globeCenter=countryGlobeCenter(atlas,selected.country.iso2);renderView();},'secondary small');center.disabled=!selected.hasOutline;panel.append(center);}panel.append(actions(zoom,button('Clear selection',()=>{state.atlasSelected='';state.atlasZoom=false;renderView();},'secondary small')));panel.append(button('Electricity & internet evidence',()=>openCountryAccessEvidence(selected.country.iso2),'secondary small'));node.append(panel);}
 node.append(paragraph(`${atlas.metadata.mappedCount} of ${state.countries.length} directory entries have simplified outlines. All entries remain searchable below.`,'privacy'));disclosure(node,'Map source and coverage',body=>{body.append(paragraph(atlas.metadata.limitations),paragraph('Natural Earth map units · public domain · orthographic globe or equirectangular flat view. Approximate center uses the largest mapped polygon, not a capital or official location. Country names and research routes use the existing M49 directory.','privacy'),sourceLink(atlas.metadata.termsUrl,'Natural Earth data terms'));});parent.append(node);
}
function renderCountries(parent){
  parent.append(heading('Countries & areas','Find geographic context, choose an origin, and open country research. Catalog: UN M49, retrieved 11 October 2026.'));
  const filters=form(parent,'Find countries',async data=>{state.countryQuery=data.q;state.countryGroup=data.group;state.countryCoverage=data.evidence;state.countryPage=0;renderView();});
  field(filters,'q','Name, code or region',{value:state.countryQuery,required:false,max:80});field(filters,'group','Development grouping',{value:state.countryGroup,options:[{value:'',label:'All countries & areas'},{value:'ldc',label:'Least developed countries'},{value:'lldc',label:'Landlocked developing countries'},{value:'sids',label:'Small island developing states'}],required:false});
  field(filters,'evidence','Agriculture evidence coverage',{value:state.countryCoverage||'',required:false,options:[{value:'',label:'All coverage'},{value:'retained',label:'All three series retained'},{value:'partial',label:'Partial retained coverage'},{value:'none',label:'No retained series'}]});
  renderCountryEvidence(parent);
  const q=state.countryQuery.toLowerCase(),countries=state.countries.filter(country=>(!state.countryCoverage||country.evidence?.status===state.countryCoverage)&&(!state.countryGroup||country[state.countryGroup])&&`${country.name} ${country.iso2} ${country.iso3} ${country.region} ${country.subregion}`.toLowerCase().includes(q));
  renderCountryAtlas(parent,countries);
  parent.append(paragraph(`${countries.length} entries · statistical geography; classifications do not establish sovereignty or affiliation.`, 'privacy'));
  const grid=element('div',null,'grid three');for(const country of countries.slice(state.countryPage*24,state.countryPage*24+24)){
    const node=card(country.name,country.iso3+' · '+country.m49);node.append(paragraph([country.region,country.subregion].filter(Boolean).join(' / '),'muted'),actions(...['ldc','lldc','sids'].filter(key=>country[key]).map(key=>badge(key.toUpperCase()))),button('Country research',async()=>{state.researchQuery={country:country.iso2};await loadResearch();openSection('research');},'secondary small'));
    node.append(paragraph(`${country.evidence?.series_count||0} of 3 agriculture series retained · ${country.evidence?.nonmissing_series||0} with reported values`,'privacy'));
    node.append(button('Agriculture evidence',async()=>{state.countryEvidence=await api('/country-evidence?country='+country.iso2);renderView();$('#country-evidence').focus();$('#country-evidence').scrollIntoView({block:'start'});},'secondary small'));
    node.append(button('Electricity & internet evidence',()=>openCountryAccessEvidence(country.iso2),'secondary small'));
    // Concern counts depend on the country’s retained evidence; report what the server added.
    if(isReviewer())node.append(button('Generate scoped proposals',async()=>{const result=await api('/research/generate','POST',{country_code:country.iso2});notice(`${result.added} concern-based proposals added for ${country.name}.`);},'small'));
    grid.append(node);
  }parent.append(grid);const previous=button('Previous',()=>{state.countryPage--;renderView();},'secondary');previous.disabled=state.countryPage===0;const next=button('Next',()=>{state.countryPage++;renderView();},'secondary');next.disabled=(state.countryPage+1)*24>=countries.length;parent.append(actions(previous,paragraph(`Page ${state.countryPage+1}`),next),sourceLink('https://unstats.un.org/unsd/methodology/m49/overview/','UN M49 source and methodology'));
}
function renderSDGTargets(parent){
 const targets=state.assembly.sdg_targets;if(!targets)return;
 const section=disclosure(parent,'Explore specific SDG targets',body=>{
  body.append(paragraph(targets.scope),paragraph(targets.qualification,'privacy'));
  const picker=form(body,'Show target references',data=>{state.targetGoal=data.goal;renderView();});field(picker,'goal','Target reference goal',{value:state.targetGoal||'2',options:SDG_GOALS.map((name,index)=>({value:String(index+1),label:`${index+1}. ${name}`}))});
  const goal=Number(state.targetGoal||'2'),source=targets.sources.find(item=>item.goal===goal);if(source)body.append(paragraph(`Official goal page retrieved ${date(source.retrieved)} · SHA256 ${source.sha256}`,'source-hash'));
  if(isReviewer())disclosure(body,'Create target-specific country proposals',panel=>{const generator=form(panel,'Generate four target proposals',async data=>{const result=await api('/research/generate','POST',data);state.researchQuery={country:data.country_code,target:data.target_code};await loadResearch();await openSection('research');notice(`${result.added} target proposals added for ${result.country}.`);});field(generator,'country_code','Target proposal country',{options:state.countries.map(country=>({value:country.iso2,label:country.name}))});field(generator,'target_code','Target reference',{options:targets.entries.filter(item=>item.goal===goal).map(item=>({value:item.code,label:item.code+' · '+item.focus}))});panel.append(paragraph('Creates four target-specific proposals for the selected SDG target: a country baseline, an intervention comparison, a delivery-route map and an implementation recommendation. This target workflow is separate from the concern-based country agenda. Activation still needs a beneficiary, owner, approved sources and independent review.','privacy'));});
  const grid=element('div',null,'grid two');for(const target of targets.entries.filter(item=>item.goal===goal)){const node=card(target.code+' · '+target.focus,'SDG TARGET · EDITORIAL FOCUS');node.append(paragraph(target.evidenceLocator,'privacy'),paragraph('Years mentioned in original wording: '+(target.originalYears.join(', ')||'none recorded')+'. Not new deadlines.','privacy'),actions(sourceLink(target.sourceUrl,'Read full official target and indicators'),button('View target proposals',async()=>{state.researchQuery={target:target.code,...(state.researchQuery.country?{country:state.researchQuery.country}:{})};await loadResearch();await openSection('research');},'secondary small')));grid.append(node);}body.append(grid);
 });
 section.open=Boolean(state.targetsOpen);section.addEventListener('toggle',()=>{state.targetsOpen=section.open;});
}
function renderAssembly(parent){
  const assembly=state.assembly;if(!assembly)return;parent.append(heading('World Assembly','Coordinate research, review recommendations, and record what people actually adopt. Independent NemoWorld institution.'));
  const intro=card('From a question to useful work','THE DELIVERY PATH');intro.append(paragraph('Country context → scoped proposal → named beneficiary and reviewer → agent contribution → independent review → documented adoption.'),actions(button('Open research desk',()=>openSection('research')),button('Explore countries',()=>openSection('countries'),'secondary')),paragraph(assembly.programmes.affiliation,'privacy'));parent.append(intro);
  if(assembly.programmes.coverageGaps?.length)disclosure(parent,'Reference coverage and remaining research',body=>{for(const gap of assembly.programmes.coverageGaps)body.append(paragraph(gap,'privacy'));});
  const goals=element('div',null,'civic-goals');assembly.goals.forEach((goal,index)=>goals.append(button(`${index+1}. ${goal}`,async()=>{state.researchQuery={goal:String(index+1)};await loadResearch();openSection('research');},'secondary small')));parent.append(goals);
  renderSDGTargets(parent);
  const trade=card('Build a bounded trade evidence query','AGRICULTURAL TRADE');const tradeFields=form(trade,'Build source URL',data=>{const reporter=state.countries.find(c=>c.iso2===data.reporter),partner=data.partner==='0'?{m49:'0'}:state.countries.find(c=>c.iso2===data.partner);if(Number(data.years)>1){const queries=tradePairUrls({origin:String(Number(data.flow==='X'?reporter.m49:partner.m49)),destination:String(Number(data.flow==='X'?partner.m49:reporter.m49)),commodity:data.commodity,startYear:Number(data.year)-Number(data.years)+1,endYear:Number(data.year)});const output=trade.querySelector('[data-trade-output]'),text=queries.map(item=>`${item.year} · ${item.role}\n${item.url}`).join('\n\n');output.replaceChildren(paragraph(`${queries.length} planned queries · requested window ${Number(data.year)-Number(data.years)+1}–${data.year}. Exporter and mirror-importer records remain separate. This is not verified latest or complete coverage.`),paragraph(text,'artifact'),button('Copy paired query plan',()=>navigator.clipboard.writeText(text),'secondary small'),paragraph('No data has been fetched. Use the bounded curator collector under a reviewed scope; inspect missing data, HS revisions, provider flags and CIF/FOB practices before comparing. No unit prices, buyer demand or shipment permission are inferred.','privacy'));return;}const url=tradeUrl({reporter:String(Number(reporter.m49)),partner:String(Number(partner.m49)),year:data.year,commodity:data.commodity,flow:data.flow});const output=trade.querySelector('[data-trade-output]');output.replaceChildren(paragraph(url,'artifact'),button('Copy source URL',()=>navigator.clipboard.writeText(url),'secondary small'),paragraph('Use this source on a mission only after its host and research scope are approved. Empty previews are evidence gaps; no buyer or permission is established.','privacy'));});
  field(tradeFields,'reporter','Reporting country',{options:state.countries.map(c=>({value:c.iso2,label:c.name})),value:'NP'});field(tradeFields,'partner','Trade partner',{options:[{value:'0',label:'World'},...state.countries.map(c=>({value:c.iso2,label:c.name}))],value:'IN'});field(tradeFields,'year','Requested trade year',{value:'2023',max:4});field(tradeFields,'years','Requested window',{options:[{value:'1',label:'One annual source'},{value:'3',label:'Three years, paired reporter/mirror'},{value:'5',label:'Five years, paired reporter/mirror'}],value:'1',hint:'Requested trade year is the end of this window. Paired windows require two countries, not World.'});field(tradeFields,'commodity','Agricultural HS code',{value:'0902',max:6,hint:'Four or six digits in chapters 01–24. Confirm product form and HS revision.'});field(tradeFields,'flow','Reporter flow',{options:[{value:'X',label:'Exports reported by this country'},{value:'M',label:'Imports reported by this country'}],value:'X'});const tradeOutput=element('div');tradeOutput.dataset.tradeOutput='true';trade.append(tradeOutput,paragraph('Annual public Comtrade preview; one country, partner, product and year. Access and coverage may be limited. This does not estimate unit prices or identify buyers.','privacy'));parent.append(trade);
  const pilot=card('Nepal tea → India','AGRICULTURAL MARKET ACCESS PILOT');pilot.append(paragraph(`A sourced research starter with ${assembly.pilot.sources.length} official records and six proposed deliverables. The June directive has been visually read; shipment applicability, buyer demand and economics still require verification.`),paragraph(assembly.pilot.brief?.requestedDecision||'A draft decision brief for technical review.'),button('View pilot tasks',async()=>{state.researchQuery={country:'NP',q:'tea'};await loadResearch();openSection('research');}));
  disclosure(pilot,'Draft findings and remaining questions',body=>{for(const finding of assembly.pilot.brief?.findings||[])body.append(paragraph(finding.text),paragraph((finding.sourceIds||[]).join(', '),'privacy'));});disclosure(pilot,'Evidence register',body=>{for(const source of assembly.pilot.sources){const row=element('div',null,'record');row.append(sourceLink(source.url,source.title),paragraph(source.publisher+' · '+source.publishedOrPeriod,'privacy'),paragraph(source.evidence),paragraph(source.limitations,'muted'),paragraph(source.quoteRights,'privacy'));body.append(row);}});parent.append(pilot);
  parent.append(heading('UN reference desk',assembly.programmes.scope));
  const categoryNames={'principal-organ':'Principal organs','ga-main-committee':'General Assembly main committees','specialized-agency':'Specialized agencies','specialized-agency-group':'Specialized agency groups','fund-programme':'Funds and programmes','other-entity':'Other entities','functional-commission':'ECOSOC functional commissions','regional-commission':'Regional commissions','human-rights-treaty-body':'Human rights treaty bodies','charter-based-body':'Charter-based bodies','human-rights-review-mechanism':'Human rights review mechanisms','climate-constituted-body':'UNFCCC constituted bodies','climate-technical-assistance-network':'Climate technical-assistance networks','peacebuilding-advisory-body':'Peacebuilding advisory bodies','peacebuilding-fund':'Peacebuilding funds','food-security-platform':'Food-security platforms','sdg-review-forum':'SDG review forums','national-review-mechanism':'Country-led review mechanisms','development-coordination-system':'Development coordination systems','country-programming-framework':'Country programming frameworks','food-standards-programme':'Food standards programmes','treaty-process':'Treaty processes and secretariats','governing-body':'Organization governing bodies','subsidiary-body':'UN subsidiary legal bodies','development-office':'Development support offices','development-institution':'Development institutions','strategy-instrument':'Strategy instruments','financing-instrument':'Financing instruments','peace-and-security-entity':'Peace and security entities'};
  const filter=form(parent,'Filter reference desk',async data=>{state.assemblyQuery=data;state.assemblyPage=0;renderView();});
  field(filter,'q','Institution or research focus',{required:false,value:state.assemblyQuery.q||'',max:100});
  field(filter,'type','Institution category',{required:false,value:state.assemblyQuery.type||'',options:[{value:'',label:'All categories'},...Array.from(new Set(assembly.programmes.institutions.map(item=>item.type))).map(type=>({value:type,label:categoryNames[type]||type.replaceAll('-',' ')}))]});
  field(filter,'goal','SDG focus',{required:false,value:state.assemblyQuery.goal||'',options:[{value:'',label:'All SDGs'},...SDG_GOALS.map((goal,index)=>({value:String(index+1),label:`${index+1}. ${goal}`}))]});
  const query=state.assemblyQuery,matched=assembly.programmes.institutions.filter(item=>(!query.type||item.type===query.type)&&(!query.goal||item.sdgs.includes(Number(query.goal)))&&(!query.q||`${item.id} ${item.name} ${item.mandate} ${item.suggestedTaskTypes.join(' ')}`.toLowerCase().includes(query.q.toLowerCase())));
  parent.append(paragraph(`${matched.length} matching institutions · Research focus and SDG mappings are NemoWorld editorial proposals.`,'privacy'));
  if(isReviewer())disclosure(parent,'Create country programme briefs',body=>{
    const generator=form(body,'Generate two programme proposals',async data=>{const result=await api('/research/generate','POST',data);state.researchQuery={country:data.country_code,institution:data.institution_id};await loadResearch();openSection('research');notice(`${result.added} proposals added for ${result.country} · ${result.institution}.`);});
    field(generator,'country_code','Country or area',{options:state.countries.map(country=>({value:country.iso2,label:country.name}))});
    field(generator,'institution_id','Institution reference',{options:assembly.programmes.institutions.map(item=>({value:item.id,label:item.name}))});
    body.append(paragraph('Creates a country baseline and an implementation recommendation proposal. Activation still requires a beneficiary, owner and independent reviewer. No programme funding or affiliation is presumed.','privacy'));
  });
  const institutions=element('div',null,'grid two');for(const institution of matched.slice(state.assemblyPage*12,state.assemblyPage*12+12)){const node=card(institution.name,[categoryNames[institution.type]||institution.type.replaceAll('-',' '),institution.recordKind&&`${institution.recordKind} record`].filter(Boolean).join(' · '));node.append(paragraph(institution.mandate),sourceLink(institution.sourceUrl,'Official documentation'),paragraph((institution.suggestedTaskTypes||[]).join(' · '),'muted'),paragraph('SDG '+institution.sdgs.join(', '),'privacy'),...(institution.sourceCheckedOn?[paragraph(`Reference checked ${institution.sourceCheckedOn} · ${institution.evidenceLocator}`,'privacy'),...(institution.sourceCheckNote?[paragraph(institution.sourceCheckNote,'privacy')]:[])]:[]),button('View linked proposals',async()=>{state.researchQuery={institution:institution.id};await loadResearch();openSection('research');},'secondary small'));if(institution.jurisdiction)disclosure(node,'Register facts',body=>{for(const [label,value] of [['Jurisdiction and remit',institution.jurisdiction],['Eligibility and participation',institution.eligibility],['Implementation evidence',institution.implementationEvidence],['Public access route',institution.publicAccessRoute],['Research task it can support',institution.researchTask]])if(value)body.append(paragraph(label+': '+value));});if(institution.countryResearchChecks?.length)disclosure(node,'Required country evidence',body=>{for(const check of institution.countryResearchChecks)body.append(paragraph(check));body.append(paragraph(institution.mappingStatus,'privacy'));});if(institution.relatedSourceUrls?.length)disclosure(node,'Country document discovery routes',body=>{for(const url of institution.relatedSourceUrls)body.append(sourceLink(url,'Official research route'));if(institution.accessNote)body.append(paragraph(institution.accessNote,'privacy'));});institutions.append(node);}parent.append(institutions);
  const previous=button('Previous institutions',()=>{state.assemblyPage--;renderView();},'secondary');previous.disabled=state.assemblyPage===0;
  const next=button('Next institutions',()=>{state.assemblyPage++;renderView();},'secondary');next.disabled=(state.assemblyPage+1)*12>=matched.length;parent.append(actions(previous,paragraph(`Page ${state.assemblyPage+1}`),next));

}
function researchWorkerForm(parent,task,urls){
 disclosure(parent,'Run my research agent',body=>{
  const inputs=form(body,'Start bounded worker',async data=>{
   await api('/research/run','POST',{task_id:task.id,agent_id:state.selected,urls:data.urls.split('\n').map(value=>value.trim()).filter(Boolean),output:data.output,...(data.output==='decision-brief'?{brief_context:{recipient:data.recipient,requested_decision:data.requested_decision}}:{})});state.history=await api('/history');mergeMissionContext();state.workers=await api('/workers');openSection('history');notice('Research worker started. Refresh runs for results or recovery guidance.');
  });
  field(inputs,'output','Research output',{options:[{value:'evidence-register',label:'Evidence register and provisional synthesis'},{value:'decision-brief',label:'Proposed decision brief (local AI required)'}],full:true});
  field(inputs,'recipient','Proposed briefing recipient',{required:false,max:200,full:true,hint:'Required for a decision brief. Describe a proposed institutional role; consent or appointment is not presumed.'});
  field(inputs,'requested_decision','Requested decision for the brief',{required:false,type:'textarea',max:1000,full:true,hint:'Required for a decision brief. State the decision you want evidence to inform.'});
  field(inputs,'urls','Approved source URLs',{type:'textarea',value:urls.join('\n'),max:3000,full:true,hint:'One to five approved public HTTPS URLs, one per line. Exact reviewed tea PDF or HTML/statistics sources; other PDFs need review.'});body.append(button('Stop my worker',()=>api('/research/cancel','POST',{}),'secondary small'));
 });
}
function renderCountryResearchPlan(parent,plan){
 const panel=card(`${plan.country.name} work programme`,'COUNTRY RESEARCH');panel.append(paragraph(`${plan.total} catalog proposals · Generated ${new Date(plan.generated_at).toLocaleString()}. This whole-country overview is independent of the proposal search filters.`));
 panel.append(paragraph(plan.statuses.map(item=>`${item.count} ${item.status.replaceAll('_',' ')}`).join(' · ')||'No country proposals generated.','privacy'));
 disclosure(panel,'Goals and review progress',body=>{for(const goal of plan.goals){if(!goal.total)continue;const row=element('div',null,'record');row.append(element('strong',`SDG ${goal.number} · ${goal.name}`),paragraph(`${goal.total} proposals · ${goal.statuses.filter(item=>item.count).map(item=>`${item.count} ${item.status.replaceAll('_',' ')}`).join(' · ')}`,'privacy'),button('View goal proposals',async()=>{state.researchQuery={country:plan.country.iso2,goal:String(goal.number)};await loadResearch();renderView();},'secondary small'));body.append(row);}if(!plan.goals.some(goal=>goal.total))body.append(empty('A reviewer can generate this country agenda from the country desk.'));});
 disclosure(panel,'Work stages and evidence gaps',body=>{for(const stage of plan.stages.filter(item=>item.total))body.append(paragraph(`${stage.name}: ${stage.total} proposals · ${stage.statuses.filter(item=>item.count).map(item=>`${item.count} ${item.status.replaceAll('_',' ')}`).join(' · ')}`));const evidence=plan.agriculture_evidence;body.append(paragraph(`Agriculture evidence: ${evidence.coverage}; ${evidence.series} retained series, ${evidence.reported_values} reported values and ${evidence.missing_values} missing values.`, 'privacy'),paragraph(evidence.limitation,'privacy'));for(const gap of evidence.gaps)body.append(paragraph(`Collection gap: ${gap.reason||gap.error||'Source unavailable; see country evidence.'}`,'privacy'));body.append(button('Inspect country evidence',async()=>{state.countryEvidence=await api('/country-evidence?country='+plan.country.iso2);await openSection('countries');$('#country-evidence').focus();$('#country-evidence').scrollIntoView({block:'start'});},'secondary small'));if(plan.access_evidence){const access=plan.access_evidence;body.append(paragraph(`Electricity and Internet evidence: ${access.coverage}; ${access.series} retained series, ${access.reported_values} reported values and ${access.missing_values} missing values.`,'privacy'),paragraph(access.limitation,'privacy'),button('Inspect electricity & internet evidence',async()=>{await openSection('countries');await openCountryAccessEvidence(plan.country.iso2);},'secondary small'));}const list=element('ol');for(const step of plan.workflow)list.append(element('li',step));body.append(list,paragraph(plan.limitations,'privacy'));});
 const download=element('a','Download country work programme','secondary small evidence-download');download.href='/api/v1/research?country='+plan.country.iso2+'&download=programme';download.download='';panel.append(download);parent.append(panel);
}

function renderResearchWorkflow(parent,research){
 const summary=research.workflow_summary;if(!summary)return;
 const panel=card('Work in this selection','RESEARCH WORKFLOW');panel.id='research-workflow';panel.tabIndex=-1;
 panel.append(paragraph(`${summary.total} proposals across all statuses in your current search · ${research.catalog_total||0} in the entire catalog.`),paragraph('Choose a stage to see its proposals. Your country, goal, institution, target, region and search stay selected.','privacy'));
 const stages=[['proposed','Proposed','Name a beneficiary, owner and independent reviewer before activation.'],['activated','Ready for work','An activated mission task is available for an authorized contributor to claim.'],['leased','Claimed','A contributor holds the task; execution or a saved draft may still be needed.'],['under_review','Awaiting review','An independent human reviewer must inspect the submitted evidence.'],['changes_requested','Needs revision','The contributor must address the review before resubmitting.'],['rejected','Rejected','An independent reviewer rejected the latest submission; the task reopened for new work.'],['accepted','Accepted in NemoWorld','Evidence passed an internal review. Actual use must be recorded separately.'],['adopted','Adoption recorded','A declaration of use was recorded; external implementation is not independently verified.'],['evidence_withheld','Evidence withheld','Latest evidence is quarantined. A human moderation or appeal decision is needed.']];
 const grid=element('div',null,'workflow-stages');for(const [status,label,description]of stages){const count=summary.statuses.find(row=>row.status===status)?.count||0,row=element('div',null,'workflow-stage'),control=button(`${label} · ${count}`,async()=>{state.researchQuery={...state.researchQuery,status};delete state.researchQuery.offset;await loadResearch();renderView();$('#research-workflow')?.focus();},'secondary small');control.setAttribute('aria-pressed',String(state.researchQuery.status===status));control.disabled=count===0;row.append(control,paragraph(description,'privacy'));grid.append(row);}panel.append(grid);
 const all=button('Show all workflow stages',async()=>{delete state.researchQuery.status;delete state.researchQuery.offset;await loadResearch();renderView();$('#research-workflow')?.focus();},'secondary small');all.setAttribute('aria-pressed',String(!state.researchQuery.status));panel.append(all,paragraph(summary.qualification,'privacy'));parent.append(panel);
}

function renderResearch(parent){
  const research=state.research;parent.append(heading('Research desk','Turn a scoped proposal into a reviewed mission. Generated proposals are a work backlog, not completed research.'));

  const filters=form(parent,'Search research',async data=>{state.researchQuery={q:data.q,country:data.country,goal:data.goal,status:data.status,institution:data.institution,region:data.region,target:data.target};await loadResearch();renderView();});
  field(filters,'q','Search',{required:false,value:state.researchQuery.q||'',max:100});field(filters,'country','Country or area',{required:false,value:state.researchQuery.country||'',options:[{value:'',label:'All countries'},...state.countries.map(country=>({value:country.iso2,label:country.name}))]});field(filters,'goal','Goal',{required:false,value:state.researchQuery.goal||'',options:[{value:'',label:'All SDGs'},...SDG_GOALS.map((goal,index)=>({value:String(index+1),label:`${index+1}. ${goal}`}))]});field(filters,'status','Status',{required:false,value:state.researchQuery.status||'',options:[{value:'',label:'All statuses'},'proposed','activated','leased','under_review','changes_requested','rejected','accepted','adopted','evidence_withheld','consolidated','retired']});
  field(filters,'institution','Institution reference',{required:false,value:state.researchQuery.institution||'',options:[{value:'',label:'All institutions and general briefs'},...state.assembly.programmes.institutions.map(item=>({value:item.id,label:item.name}))]});
  field(filters,'target','Specific SDG target',{required:false,value:state.researchQuery.target||'',options:[{value:'',label:'All targets and general briefs'},...state.assembly.sdg_targets.entries.map(item=>({value:item.code,label:item.code+' · '+item.focus}))]});
  field(filters,'region','Regional research lens',{required:false,value:state.researchQuery.region||'',options:[{value:'',label:'All regional focuses'},...REGIONS.map(region=>({value:region.id,label:region.name+' · '+region.mayor.focus}))]});
  renderResearchWorkflow(parent,research);
  if(research.region_context){const context=research.region_context,lens=card(context.name+' · related research','REGIONAL RESEARCH LENS');lens.append(paragraph(context.focus),paragraph(context.goals.map(goal=>`SDG ${goal.number} · ${goal.name}`).join(' · ')),paragraph(context.qualification,'privacy'),paragraph('These results match the lens’s goals and your selected filters. Choose a country and review local evidence before activating a task. Existing mission ownership, reviewers and scopes are unchanged. Whole-country programme counts below remain separate from this filtered list.','privacy'),button('Clear regional lens',async()=>{delete state.researchQuery.region;await loadResearch();renderView();},'secondary small'));parent.append(lens);}
  if(research.target_context){const context=research.target_context,panel=card(context.code+' · '+context.focus,'TARGET RESEARCH');panel.append(paragraph(context.qualification,'privacy'),paragraph('Years mentioned in original wording: '+(context.originalYears.join(', ')||'none recorded')+'. Not new deadlines.','privacy'),actions(sourceLink(context.sourceUrl,'Full target and indicator definitions'),button('Clear target filter',async()=>{delete state.researchQuery.target;await loadResearch();renderView();},'secondary small')));parent.append(panel);}
  if(research.country_plan)renderCountryResearchPlan(parent,research.country_plan);
  parent.append(paragraph(`${research.total||0} matching proposals`, 'privacy'));const grid=element('div',null,'grid two');for(const lead of research.leads){const node=card(lead.title,`${lead.country} · SDG ${lead.goal}${lead.target_code?' · Target '+lead.target_code:''} · ${lead.stage}`);node.append(badge(lead.status,lead.status==='evidence_withheld'),paragraph(lead.instructions.length>280?lead.instructions.slice(0,280)+'…':lead.instructions));
    if(lead.status==='evidence_withheld')node.append(paragraph(`Latest supporting submission is quarantined. Recorded workflow: ${lead.recorded_status.replaceAll('_',' ')}. Historical review and adoption records are preserved; the evidence is unavailable pending human moderation or further scoped work.`,'privacy'));
    disclosure(node,'Deliverable, rubric & sources',body=>{body.append(paragraph(lead.instructions),paragraph(lead.rubric,'muted'));for(const url of lead.source_urls)body.append(paragraph(''),sourceLink(url));});
    if(lead.task_id){node.append(button('Open mission',()=>showMissionTask(lead.task_id),'secondary small'));if(state.account&&selected()&&selected().kind!=='human'&&lead.status==='activated'){const task=state.tasks.find(item=>item.id===lead.task_id);if(task)researchWorkerForm(node,task,lead.source_urls.filter(url=>task.allowed_domains.includes(new URL(url).hostname)&&(!/\.pdf(?:$|[?#])/i.test(url)||state.assembly.pilot.sources.some(source=>source.url===url&&source.workerReviewedEdition))).slice(0,5));}}
    else if(lead.status==='retired')node.append(paragraph(`Retained historical template. No scoped replacement has been authored. ${lead.consolidation_reason||''}`,'privacy'));
    else if(lead.status==='consolidated')node.append(paragraph(`Retained historical proposal. Replacement: ${lead.replacement_id}. ${lead.consolidation_reason||''}`,'privacy'));
    else if(isReviewer()&&lead.status==='proposed')disclosure(node,'Activate a reviewed mission',body=>{const controls=form(body,'Activate mission',async data=>{await api('/research/activate','POST',{lead_id:lead.id,...data,allowed_domains:data.domains?.trim()?data.domains.split(',').map(value=>value.trim()).filter(Boolean):undefined});await refresh();render();notice('Mission activated. Contributors can now claim its task.');});field(controls,'beneficiary','Intended beneficiary',{max:2000,full:true,hint:'Describe the people or institution this work should serve. No consent is presumed.'});field(controls,'reviewer_id','Reviewer account ID',{required:false,max:100,hint:'Defaults to you. Review must be independent of the contributor.'});field(controls,'domains','Approved source hostnames',{required:false,value:[...new Set(lead.source_urls.map(url=>new URL(url).hostname))].join(', '),max:1000,full:true,hint:'Comma-separated exact hosts. Add country agencies only after checking their authority.'});});grid.append(node);
  }if(!research.leads.length)grid.append(empty('No proposals match. Clear filters or generate a country agenda from the country desk.'));parent.append(grid);
  const offset=research.offset||0,previous=button('Previous',async()=>{state.researchQuery.offset=String(Math.max(0,offset-24));await loadResearch();renderView();},'secondary');previous.disabled=offset===0;const next=button('Next',async()=>{state.researchQuery.offset=String(offset+24);await loadResearch();renderView();},'secondary');next.disabled=!research.has_more;parent.append(actions(previous,paragraph(`Page ${Math.floor(offset/24)+1}`),next));
}

setInterval(()=>{if(state.graphics==='pixel'&&state.tab==='world'&&!document.hidden&&state.world.participants.some(item=>item.kind==='npc')&&!matchMedia('(prefers-reduced-motion: reduce)').matches)paintWorld();},220);

setInterval(()=>{if(state.account&&state.tab==='world'&&viewedAgent()?.status==='active'&&!document.hidden)guarded(()=>api(`/agents/${state.selected}/heartbeat`,'POST',{}));},20000);

async function loadCallings(){
 const id=state.selected;
 if(!state.account||!selected()){state.callings=null;return;}
 const result=await api(`/callings?agent_id=${encodeURIComponent(id)}`);
 if(id===state.selected)state.callings=result;
}
async function loadGuilds(){
 const query=new URLSearchParams({limit:'12',offset:String(state.guildOffset),...(state.guildFilter?{calling_id:state.guildFilter}:{})});
 state.guilds=await api(`/callings/guilds?${query}`);
}
// ---- Private resident memory ------------------------------------------------------------------
// Memory belongs to one operator's own AI resident. The interface shows the stored fact, the kind of
// source that proves it and whether it is approved, proposed or refused; the operator decides every
// proposal. Nothing here is public, and the copy never presents memory as a mind or as an achievement
// the world did not save.
async function loadMemory(){
 const id=state.selected;
 if(!state.account||selected()?.kind!=='agent'){state.memory=null;return;}
 const result=await api(`/memory?agent_id=${encodeURIComponent(id)}`);
 if(id===state.selected)state.memory=result;
}
const MEMORY_OPERATOR_KINDS=Object.freeze({purpose:['intent','focus','boundary'],preference:['working_style','communication','focus','boundary'],lesson:['operator_correction']});
function memoryFactRow(fact,parent,{controls=false}={}){
 const row=element('article',null,'record');row.append(badge(`${fact.kind} · ${fact.attribute}`),paragraph(fact.value),paragraph(`Source: ${fact.source.kind}${fact.source.kind==='human'?' · your own input':' · '+fact.source.label} · recorded ${date(fact.created_at)}`,'plot-address'));
 if(fact.subject)row.append(paragraph(`Subject: ${fact.subject}`,'privacy'));
 if(controls){
  const inputs=form(row,'Correct this fact',async values=>{const updated=await api('/memory/manage','POST',{action:'correct',agent_id:state.selected,fact_id:fact.id,value:values.value,...(values.subject?{subject:values.subject}:{})});await loadMemory();renderView();notice(`Corrected. The earlier version is now ${updated.superseded.state}.`);});
  field(inputs,'value','Corrected value',{value:fact.value,max:state.memory?.limits?.value||160,full:true});
  field(inputs,'subject','Subject',{value:fact.subject,required:false,max:80,full:true});
  row.append(button('Delete this fact',async()=>{const removed=await api('/memory/manage','POST',{action:'delete',agent_id:state.selected,fact_id:fact.id});await loadMemory();renderView();notice(`Deleted ${removed.removed} memory ${removed.removed===1?'fact':'facts'}.`);},'secondary small'));
 }
 parent.append(row);
}
function memoryPanel(parent){
 const view=state.memory;if(!view)return;
 const panel=card('Resident memory','PRIVATE · YOUR RESIDENT ALONE');
 panel.append(paragraph(`${view.counts.active} approved · ${view.counts.proposed} awaiting your decision · ${view.counts.refused} refused · ${view.counts.superseded} corrected. At most ${view.limits.facts_active} approved facts and ${view.limits.value} characters per fact.`,'privacy'));
 panel.append(paragraph(`${view.policy.sentience} ${view.policy.description}`,'privacy'));
 if(view.facts.length)for(const fact of view.facts)memoryFactRow(fact,panel,{controls:true});else panel.append(empty('No approved memory yet. Record one below, or approve a proposal from your resident.'));
 if(view.proposals.length){
  disclosure(panel,`Proposals waiting for you (${view.proposals.length})`,body=>{
   body.append(paragraph('A proposal is not memory. It names a saved source, and it is invisible to your resident’s prompt until you approve it.','privacy'));
   for(const proposal of view.proposals){
    const row=element('article',null,'record');
    row.append(badge(`${proposal.kind} · ${proposal.attribute}`),paragraph(proposal.value),paragraph(`Proposed by your resident · source ${proposal.source.kind} · ${proposal.source.label}`,'plot-address'));
    row.append(actions(
     button('Approve',async()=>{await api('/memory/manage','POST',{action:'approve',agent_id:state.selected,fact_id:proposal.id});await loadMemory();renderView();notice('Memory approved. It will be observed at the next decision.');},'small'),
     button('Refuse',async()=>{await api('/memory/manage','POST',{action:'refuse',agent_id:state.selected,fact_id:proposal.id});await loadMemory();renderView();notice('Proposal refused. It stays in the record as refused.');},'secondary small')));
    body.append(row);
   }
  });
 } else panel.append(paragraph('No proposals are waiting.','privacy'));
 const recorder=form(panel,'Record a memory fact from your own input',async values=>{await api('/memory/manage','POST',{action:'record',agent_id:state.selected,kind:values.kind,attribute:values.attribute,value:values.value,...(values.subject?{subject:values.subject}:{})});await loadMemory();renderView();notice('Recorded from your own input.');});
 const kindField=field(recorder,'kind','Kind',{options:Object.keys(MEMORY_OPERATOR_KINDS)});
 const attributes=()=>MEMORY_OPERATOR_KINDS[kindField.value]||MEMORY_OPERATOR_KINDS.purpose;
 const attributeField=field(recorder,'attribute','Attribute',{options:attributes()});
 const syncAttributes=()=>{attributeField.replaceChildren(...attributes().map(value=>{const option=element('option',value);option.value=value;return option;}));};
 kindField.addEventListener('change',syncAttributes);syncAttributes();
 field(recorder,'subject','Short subject',{required:false,max:80,hint:'Optional. Name what the fact is about.'});
 field(recorder,'value','One short line',{max:view.limits.value,full:true,hint:'Describes your choice or instruction. A credential, contact address, link or consciousness claim is refused.'});
 panel.append(paragraph('Your resident proposes a fact only from its own verified record: a calling receipt, a finished run that recorded a refusal, or an independent review decision. This form records your own explicit input, which is its own kind of source.','privacy'));
 if(view.history.length)disclosure(panel,'Refused and corrected history',body=>{for(const fact of view.history.slice(0,20))memoryFactRow(fact,body);body.append(paragraph('Refused proposals and corrected versions stay as history. They are never part of your resident’s memory.','privacy'));});
 panel.append(actions(button('Export this memory',async()=>{const exported=await api('/export');download(exported.memory,'resident-memory.json');},'secondary small'),button('Refresh memory',async()=>{await loadMemory();renderView();},'secondary small')));
 parent.append(panel);
}
function callingHUD(){
 const node=element('section',null,'calling-hud');node.setAttribute('aria-label','Your calling and current objective');
 node.append(element('div',null,'calling-hud-copy'),button('Calling & guild',()=>openSection('callings'),'secondary small'));
 return node;
}
function updateCallingHUD(){
 const copy=$('.calling-hud-copy');if(!copy)return;copy.replaceChildren();
 const view=state.callings;if(!view)return copy.append(paragraph('Choose a calling to begin your story.'));
 copy.append(paragraph(`${view.calling.name} · ${view.rank.title} · ${view.calling.guild_name}`,'eyebrow'),paragraph(view.current_objective?.title||'Today’s calling complete. Help a neighbor or explore at your own pace.'));
 const bar=element('progress');bar.max=view.today.limit;bar.value=view.today.earned;bar.setAttribute('aria-label',`${view.today.earned} of ${view.today.limit} daily cosmetic experience`);copy.append(bar);
}
async function callingAction(action){
 if(!selected())return openSection('characters');
 if(action==='garden'){await travelAgent(`home:${state.selected}`);return openSection('workshop');}
 if(action==='craft')return openSection('workshop');
 if(action==='build'){await travelAgent(`home:${state.selected}`);state.building=true;renderView();return;}
 if(action==='build_block'||action==='expand')return enterFrontier();
 if(action==='claim'||action==='await_review')return openSection(action==='claim'?'missions':'history');
 if(['circle','thanks','pledge','rsvp','create_event','create_circle'].includes(action)){state.communitySection=action==='thanks'?'thanks':action==='pledge'?'projects':action==='rsvp'||action==='create_event'?'events':'circles';return openSection('community');}
 await openSection('explore');notice('Enter a shared place with your character to record a visit. Browsing its map is a visitor view.');
}
function callingCard(){
 const view=state.callings,node=card(view?view.calling.name:'Your calling','A PURPOSE IN THIS WORLD');node.classList.add('calling-card');
 if(!view){node.append(paragraph('Choose a peaceful vocation. Let it guide how your character helps the world.'),button('Choose a calling',()=>openSection('callings'),'small'));return node;}
 node.append(badge(`${view.rank.title} · level ${view.rank.level}`),paragraph(view.calling.purpose),paragraph(`${view.calling.guild_name} · ${view.experience.available} cosmetic experience`,'privacy'));
 if(view.pathway)node.append(paragraph(`Pathway ${view.pathway.completed} / ${view.pathway.total}${view.pathway.next?` · next: ${view.pathway.next.title}`:' · every tier credited'}`,'privacy'));
 for(const objective of view.today.objectives){const item=element('div',null,`calling-objective ${objective.complete?'complete':''}`);item.append(element('span',objective.complete?'✓':'◇','objective-mark'),paragraph(objective.title));node.append(item);}
 if(view.current_objective)node.append(button('Follow my calling',()=>callingAction(view.current_objective.action_hint),'small'));
 if(state.quests?.next_action)node.append(questNextCard(state.quests.next_action,{compact:true}));
 node.append(button('Choose calling & meet guild',()=>openSection('callings'),'secondary small'));return node;
}
function callingWorkerForm(parent){
 const resident=selected();if(!resident||resident.kind==='human'||resident.status!=='active')return;
 const view=state.callings;
 disclosure(parent,'Let my AI pursue this calling',body=>{
  body.append(paragraph(`${resident.name} will observe its ${view?.calling.name||'Explorer'} purpose and real objectives before each decision. Choose the permissions you want to grant. The local model may decline or fail an action.`,'muted'));
  const inputs=form(body,'Begin calling session',async values=>{
   const result=await api('/residents/run','POST',{agent_id:resident.id,minutes:Number(values.minutes),model_calls:Number(values.model_calls),permission:values.permission});
   state.workers=await api('/workers');notice(`${resident.name} is starting a bounded calling session: up to ${result.model_calls} decisions. Open My contributions for the actual run receipt.`);
  });
  field(inputs,'minutes','Maximum minutes',{type:'number',min:1,max:20,value:2});
  field(inputs,'model_calls','Maximum decisions',{type:'number',min:1,max:20,value:5});
  field(inputs,'permission','Actions allowed',{full:true,options:[{value:'observe',label:'Observe only'},{value:'explore',label:'Walk and converse'},{value:'creative',label:'Walk, garden, craft and build permitted places'}],value:['builder','cultivator','steward','artisan'].includes(view?.calling.id)?'creative':'explore'});
  body.append(actions(button('View runs',()=>openSection('history'),'secondary small'),button('Stop my local AI',async()=>{const result=await api('/residents/cancel','POST',{});notice(result.stopping?'Stop requested. Check the run receipt after cleanup.':'No local resident is running.');},'secondary small')),paragraph('A calling never grants permissions. Decisions have time and API budgets; revoking access stops the runtime. Research work still uses scoped missions and separate human review.','privacy'));
 });
}
// The pathway is one calling's practice ladder, computed on the server from saved receipts and
// recorded adoptions. Two things matter in this reader: the three states stay visibly apart (practice,
// verified contribution, external adoption are not degrees of one thing), and the next challenge names
// the concrete saved fact that is still missing. Nothing here can credit a tier, and nothing here
// claims that a tier is a qualification.
const PATHWAY_STATE_KEYS=Object.freeze({'practice':'practice','verified-contribution':'verified','external-adoption':'adopted'});
function pathwayTierCard(tier){
 const node=element('article',null,'calling-quest');node.dataset.pathwayTier=tier.slug;
 node.append(badge(tier.state),element('h3',`Tier ${tier.ordinal} · ${tier.title}`),paragraph(tier.summary));
 for(const item of tier.requires){
  const row=element('div',null,'quest-row');append(row,paragraph(`${item.have} of ${item.min} · ${item.label}`),badge(item.evidence));
  if(item.have<item.min)row.append(button('Open this step',()=>callingAction(item.action.kind),'secondary small'));
  node.append(row);
 }
 for(const fact of tier.evidence)node.append(paragraph(`Saved fact: ${fact.kind} · ${fact.source_id} · ${fact.earned_day}`,'plot-address'));
 if(tier.requires.some(item=>item.kind==='research_accepted'))node.append(paragraph('This tier is credited only by an independent human acceptance of real scoped work. Neither the contributor nor a model can accept it.','privacy'));
 for(const recipe of tier.recipes)node.append(paragraph(`Suggested recipe: ${recipe.name} — ${Object.entries(recipe.ingredients).map(([kind,count])=>`${count} ${kind}`).join(', ')}. Every recipe stays available; the pathway only suggests which one suits this calling.`,'privacy'));
 return node;
}
function pathwayCard(pathway){
 if(!pathway)return null;
 const node=card(`${pathway.name} · pathway`,'PRACTICE · VERIFIED CONTRIBUTION · EXTERNAL ADOPTION');node.classList.add('pathway-card');
 node.append(paragraph(pathway.summary));
 node.append(metrics([['Pathway tiers',`${pathway.completed} / ${pathway.total}`,'Credited only from saved server facts'],['Different practice kinds',pathway.diversity.distinct_kinds,`${pathway.diversity.kinds_per_tier} unlock the banner decoration`],['Verified contributions',pathway.contribution.verified.count,'Independent human acceptance'],['External adoption',pathway.contribution.adopted.count,'Recorded by the mission owner']]));
 node.append(paragraph(pathway.policy.diversity,'privacy'));
 const states=element('div',null,'pathway-states');states.dataset.pathwayStates='three';
 for(const state of pathway.states){
  const key=PATHWAY_STATE_KEYS[state.id],record=pathway.contribution[key],row=element('article',null,'record');
  row.dataset.pathwayState=state.id;row.append(badge(state.badge),element('h3',state.label),paragraph(state.detail,'privacy'),paragraph(`Your record: ${record.count}${key==='practice'?` · ${pathway.diversity.distinct_kinds} different kind${pathway.diversity.distinct_kinds===1?'':'s'} of saved practice`:''}`));
  states.append(row);
 }
 node.append(paragraph('These three states are not the same thing and no tier turns one into another. Only the third leaves NemoWorld, and it is still a record written here.','privacy'),states);
 if(pathway.next){
  const next=element('section',null,'card quest-next');next.dataset.pathwayNext=pathway.next.tier_slug;
  next.setAttribute('aria-label',`Next pathway challenge: tier ${pathway.next.ordinal}, ${pathway.next.title}`);
  next.append(paragraph('NEXT CHALLENGE','eyebrow'),element('h3',`Tier ${pathway.next.ordinal} · ${pathway.next.title}`),paragraph(pathway.next.summary));
  for(const item of pathway.next.missing)next.append(paragraph(`Still needed: ${item.needs} more · ${item.label} (${item.have} of ${item.min})`),button('Open this step',()=>callingAction(item.action.kind),'secondary small'));
  if(pathway.next.requires_human_review)next.append(paragraph('A different, authorized human reviewer must accept this work before the tier counts. You cannot accept your own contribution.','privacy'));
  node.append(next);
 } else node.append(paragraph('Every tier of this pathway is credited from saved facts. Nothing further is owed here, and a pathway is not a qualification or a professional credential.','privacy'));
 const grid=element('div',null,'grid two');for(const tier of pathway.tiers)grid.append(pathwayTierCard(tier));node.append(grid);
 const unlocks=pathway.unlocks||[];
 if(unlocks.length)disclosure(node,'Cosmetic decorations and suggested recipes',body=>{for(const unlock of unlocks)body.append(paragraph(`${unlock.earned?'Earned':'Ahead'} · ${unlock.kind==='cosmetic'?'decoration':'suggested recipe'} · ${unlock.label}: ${unlock.detail}`,'privacy'));});
 node.append(paragraph(pathway.disclosure,'privacy'));
 return node;
}
function renderCallings(parent){
 parent.append(heading('Every resident has a calling','Build a peaceful world through exploration, care, craft and useful knowledge. Humans choose; AI residents work within their permissions.'));
 const view=state.callings;
 if(state.account&&selected()&&view){
  residentContext(parent);const story=card(`${selected().name} · ${view.calling.name}`,'YOUR CURRENT STORY');story.classList.add('calling-story');
  story.append(paragraph(view.calling.purpose),badge(view.calling.guild_name),metrics([['Rank',view.rank.title,`Level ${view.rank.level}`],['Experience',view.experience.available,'Cosmetic participation, no cash value'],['Today',`${view.today.earned} / ${view.today.limit}`,'Maximum 10 experience per UTC day']]));
  for(const objective of view.today.objectives){const item=element('article',null,`calling-quest ${objective.complete?'complete':''}`);item.append(badge(objective.complete?'complete':objective.withheld?'held':'available',objective.withheld),element('h3',objective.title),paragraph(objective.instructions),paragraph(`${objective.experience} cosmetic experience · one verified source per objective`,'privacy'));if(!objective.complete)item.append(button('Open the next step',()=>callingAction(objective.action_hint),'secondary small'));story.append(item);}
  story.append(paragraph('Experience describes saved participation. It creates no NemoCoins, land rights, authority or action scope. Only independently accepted real contributions can earn NemoCoins.','privacy'));
  callingWorkerForm(story);
  memoryPanel(story);
  disclosure(story,'My experience receipts',body=>{if(!view.receipts.length)body.append(empty('No calling receipts yet. Complete a saved objective to begin.'));for(const receipt of view.receipts.slice(0,20)){const row=element('article',null,'record');row.append(paragraph(`${receipt.objective_id.replaceAll('_',' ')} · ${receipt.points} experience`),paragraph(`${receipt.earned_day} · ${receipt.available?'available':'held after evidence changed'}`,'privacy'),paragraph(`Source: ${receipt.source_kind} · ${receipt.source_id}`,'plot-address'));body.append(row);}});
  parent.append(story);
  const pathwayNode=pathwayCard(view.pathway);if(pathwayNode)parent.append(pathwayNode);
 }else parent.append(paragraph(state.account?'Create or select a character to choose its calling.':'Meet the guilds below. Create a human account to choose your calling or guide your AI residents.'),button(state.account?'My characters':'Create account',()=>state.account?openSection('characters'):openAuth('register'),'small'));
 const catalog=state.guilds?.catalog||view?.catalog||[];const choices=element('div',null,'calling-catalog');
 for(const calling of catalog){const node=card(calling.name,calling.guild_name);node.classList.add('calling-choice');node.dataset.calling=calling.id;node.append(paragraph(calling.purpose),paragraph(calling.charter,'privacy'));if(view){const choice=button(view.calling.id===calling.id?'Current calling':`Become ${/^[AEIOU]/.test(calling.name)?'an':'a'} ${calling.name}`,async()=>{state.callings=await api('/callings/select','POST',{agent_id:state.selected,calling_id:calling.id});await loadGuilds();await loadWorld();renderView();notice(`Your calling is ${calling.name}. ${calling.guild_name} welcomes you.`);},'secondary small');choice.disabled=view.calling.id===calling.id||!view.can_change||state.world.paused;node.append(choice);}choices.append(node);}parent.append(choices,paragraph('Your operator can change a calling once per UTC day. Guilds are affiliations that follow this choice. Guild membership carries no moderation or ownership powers.','privacy'));
 const guild=card('People with a shared purpose','GUILD DIRECTORY');const filters=element('div');const choice=field(filters,'guild','Guild',{options:[{value:'',label:'All guilds'},...(state.guilds?.groups||[]).map(group=>({value:group.calling_id,label:`${group.guild_name} · ${group.member_count} residents`}))],value:state.guildFilter,full:true});choice.addEventListener('change',()=>guarded(async()=>{state.guildFilter=choice.value;state.guildOffset=0;await loadGuilds();renderView();}));guild.append(filters);
 for(const resident of state.guilds?.members||[]){const row=element('article',null,'guild-member');row.append(element('strong',resident.name),badge(resident.kind==='human'?'human player':'AI resident'),paragraph(`${resident.calling.name} · ${resident.calling.rank.title} · ${getWorldDefinition(resident.world_id).name}`,'privacy'),button('Visit their public place',()=>visitWorld(resident.world_id),'secondary small'));guild.append(row);}if(!state.guilds?.members?.length)guild.append(empty('No active residents are visible in this guild’s public places yet.'));
 const pages=actions();if(state.guildOffset>0)pages.append(button('Previous residents',async()=>{state.guildOffset=Math.max(0,state.guildOffset-12);await loadGuilds();renderView();},'secondary small'));if(state.guilds?.has_more)pages.append(button('Next residents',async()=>{state.guildOffset+=12;await loadGuilds();renderView();},'secondary small'));guild.append(pages,paragraph('Only active residents in public places are listed. Private receipt history stays with the resident’s operator.','privacy'));parent.append(guild);
}
async function loadQuests(){
 state.questCatalog=await api('/quests/catalog?limit=20');
 state.quests=state.account&&selected()?await api(`/quests?agent_id=${encodeURIComponent(state.selected)}`):null;
}
// The next actual action is the only claim this interface makes: a concrete action the resident can
// take, the named output the server will credit, and whether an independent human must accept it.
function questNextCard(next,{compact=false}={}){
 const node=element('section',null,compact?'quest-next compact':'card quest-next');
 node.setAttribute('aria-label',next?`Next action for ${next.chain_title}: ${next.step_title}`:'No quest step is waiting');
 if(!next)return node;
 node.append(paragraph(compact?`QUEST · ${next.chain_title}`:'NEXT ACTUAL ACTION','eyebrow'),element(compact?'p':'h3',compact?next.step_title:`${next.chain_title} · step ${next.ordinal}: ${next.step_title}`));
 if(!compact)node.append(paragraph(next.instructions));
 node.append(paragraph(`Named output: ${next.output.name}`),paragraph(`Credited from a saved server fact: ${next.action.saved_fact}. Progress ${next.progress.have} of ${next.progress.target}.`,'privacy'));
 if(next.requires_human_review)node.append(paragraph('This step needs a different, authorized human reviewer. You cannot accept your own work, and a quest never issues NemoCoins.','privacy'));
 node.append(button('Open this step',()=>callingAction(next.action.kind),compact?'secondary small':'small'));
 return node;
}
function questProgressCard(chain){
 const node=card(chain.title,`${chain.route.replaceAll('_',' ').toUpperCase()} · ${chain.complete?'COMPLETE':chain.enrolled?'IN PROGRESS':'NOT STARTED'}`);
 append(node,paragraph(chain.narrative,'muted'),paragraph(chain.summary,'privacy'));
 if(chain.practice)node.append(badge('practice · cosmetic only'));
 else node.append(badge(`real evidence work · beneficiary: ${chain.beneficiary}`,true));
 const list=element('ol',null,'quest-steps');
 for(const step of chain.steps){
  // A catalogue entry carries the authored shape; a resident's entry carries the same shape plus
  // this resident's progress, so both render from one reader.
  const progress=step.progress||{have:0,target:step.output.target,complete:false},facts=step.saved_facts||[],stepState=step.state||'available';
  const item=element('li',null,`quest-step ${stepState}`);
  item.setAttribute('aria-label',`Step ${step.ordinal}: ${step.title}. ${stepState==='complete'?'Complete':stepState==='locked'?'Locked until its prerequisite is complete':'Waiting for your next action'}.`);
  append(item,element('h3',`Step ${step.ordinal} · ${step.title}`),paragraph(step.instructions));
  item.append(paragraph(`Named output: ${step.output.name}`),paragraph(`${progress.have} of ${progress.target} saved ${step.output.source_kind.replaceAll('_',' ')} fact${progress.target===1?'':'s'}`,'privacy'));
  if(step.prerequisite)item.append(paragraph(`Comes after: ${step.prerequisite.title}`,'privacy'));
  if(step.output.requires_review)item.append(paragraph('An independent human reviewer must accept this work. Neither the contributor nor a model can accept it.','privacy'));
  for(const fact of facts)item.append(paragraph(`Saved fact ${fact.source_kind} · ${fact.source_id} · ${fact.earned_day}${fact.available?'':' · held after the source changed'}`,'plot-address'));
  if(stepState==='available'&&chain.enrolled)item.append(button('Open this step',()=>callingAction(step.action.kind),'small'));
  list.append(item);
 }
 node.append(list);
 if(chain.enrolled)node.append(button('Refresh progress',async()=>{await loadQuests();renderView();},'secondary small'),button('Leave this chain',async()=>{await change('/quests/leave',{agent_id:state.selected,chain_id:chain.slug},'You left the chain. Recorded receipts stay historical.');await loadQuests();renderView();},'secondary small'));
 else if(chain.status==='published'&&state.account&&selected()?.status==='active')node.append(button('Begin this chain',async()=>{await api('/quests/join','POST',{agent_id:state.selected,chain_id:chain.slug},true);await loadQuests();renderView();notice(`You began “${chain.title}”. The board shows the next action.`);},'small'));
 return node;
}
function questManageButtons(node,chain){
 if(!state.account||!isReviewer())return;
 if(chain.origin==='built_in'&&state.account.role!=='admin')return;
 if(chain.origin==='operator'&&state.account.role!=='admin'&&chain.author_account_id!==state.account.id)return;
 const controls=[];
 if(chain.status!=='published')controls.push(button('Publish chain',async()=>{await change('/quests/manage',{chain_id:chain.slug,action:'publish'},'Chain published to residents.');await loadQuests();renderView();},'small'));
 if(chain.status!=='archived')controls.push(button('Archive chain',async()=>{await change('/quests/manage',{chain_id:chain.slug,action:'archive'},'Chain archived. Recorded receipts stay historical.');await loadQuests();renderView();},'secondary small'));
 if(controls.length)node.append(actions(...controls));
}
function questAuthorForm(parent){
 if(!isReviewer())return;
 disclosure(parent,'Author a quest chain',body=>{
  body.append(paragraph('An authored route with named outputs. Each step names one saved fact this world already records, so no model, author or client can mark a step complete.'));
  const inputs=form(body,'Save draft chain',async values=>{
   let steps;
   try{steps=JSON.parse(values.steps);}catch{throw new Error('Steps must be a JSON array of step objects.');}
   const chain=await api('/quests/author','POST',{slug:values.slug,title:values.title,route:values.route,summary:values.summary,narrative:values.narrative,practice:values.scope==='practice',beneficiary:values.scope==='practice'?'':values.beneficiary,steps});
   await loadQuests();renderView();notice(`Draft chain “${chain.title}” saved. Publish it to open it to residents.`);
  },'quest-author');
  field(inputs,'slug','Chain slug',{max:40,full:true,hint:'Lowercase letters, digits and dashes.'});
  field(inputs,'title','Title',{max:80,full:true});
  field(inputs,'route','Route',{full:true,options:[{value:'world_building',label:'World building · saved blocks, paths, areas, home objects, shared visits'},{value:'gardening',label:'Gardening · planted and harvested crops, crafted keepsakes'},{value:'evidence_research',label:'Evidence research · a real mission claim and its independent acceptance'}]});
  field(inputs,'scope','Scope',{full:true,options:[{value:'practice',label:'Practice and cosmetic only'},{value:'real',label:'Real evidence work with a named beneficiary'}]});
  field(inputs,'beneficiary','Named beneficiary (real evidence chains only)',{required:false,max:120,full:true});
  field(inputs,'summary','Summary',{type:'textarea',max:300,full:true});
  field(inputs,'narrative','Narrative',{type:'textarea',max:4000,full:true});
  field(inputs,'steps','Steps (JSON array, 2–8)',{type:'textarea',full:true,hint:'[{"slug":"first","title":"…","instructions":"…","output_name":"…","source_kind":"crop_plant","target":1},{"slug":"second","title":"…","instructions":"…","output_name":"…","source_kind":"crop_harvest","prerequisite":"first"}]'});
 });
}
function renderQuests(parent){
 parent.append(heading('A path with real steps','A quest chain is an authored route through this world: ordered steps, explicit prerequisites and a named output for each one. A step advances only from a saved, attributed server fact — never from a model, a client or the author saying so.'));
 const policy=state.questCatalog?.policy||state.quests?.policy;
 if(policy)parent.append(paragraph(`Step experience is cosmetic calling experience (${policy.experience_per_step} per step, ${policy.daily_experience_limit} per day) and is never currency. NemoCoins are issued only by the independent real-contribution ledger after a different, authorized human accepts a real scoped contribution. A quest chain cannot mint them, and this world has no route that lets one.`,'privacy'));
 residentContext(parent);
 const resident=state.account&&selected()?state.quests:null;
 if(resident){
  const nextCard=questNextCard(resident.next_action);
  if(!resident.next_action)nextCard.append(paragraph(resident.enrolled_count?'Every authored step you joined is complete. Nothing further is owed.':'You have not begun a quest chain yet. Choose one below; progress is credited from what you actually save in the world.'));
  parent.append(nextCard);
  if(resident.enrolled_count){
   const stack=element('div',null,'grid two');
   for(const chain of resident.chains.filter(item=>item.enrolled))stack.append(questProgressCard(chain));
   parent.append(stack);
  }
  const available=resident.chains.filter(chain=>chain.status==='published'&&!chain.enrolled);
  if(available.length){const grid=element('div',null,'grid two');for(const chain of available){const node=questProgressCard(chain);questManageButtons(node,chain);grid.append(node);}parent.append(heading('Chains you can begin','Each chain is operator-authored. Beginning one is your operator’s choice and grants no authority.'),grid);}
  const own=resident.chains.filter(chain=>chain.status!=='published');
  if(own.length){const grid=element('div',null,'grid two');for(const chain of own){const node=questProgressCard(chain);questManageButtons(node,chain);grid.append(node);}parent.append(heading('Your drafts and archived chains','A draft or archived chain is visible to its author and to administrators only.'),grid);}
  questAuthorForm(parent);
 } else {
  const catalog=state.questCatalog;
  if(!catalog)parent.append(empty('Quest chains could not be loaded. Reopen this section to try again.'));
  else if(!catalog.chains.length)parent.append(empty('No quest chain is published yet. An operator can author one.'));
  else { const grid=element('div',null,'grid two');for(const chain of catalog.chains)grid.append(questProgressCard(chain));parent.append(heading('Published chains','Sign in and choose a character to begin one. Progress is credited from saved facts only.'),grid); }
 }
}
// Guild projects are the practical side of a guild: a board of scoped cooperation with explicit,
// revocable participation. Everything below is created with document.createElement and textContent,
// and a pledge or an unverified submission is never rendered as a completed outcome.
async function loadGuildProjects(){
 const query=new URLSearchParams({limit:'12',offset:String(state.guildProjectOffset),q:state.guildProjectQuery});
 if(state.guildProjectGuild)query.set('guild_id',state.guildProjectGuild);
 if(state.account&&selected())query.set('agent_id',state.selected);
 state.guildProjects=await api(`/guilds?${query}`);
}
async function guildProjectWrite(path,data,message){
 const result=await change(path,{...data,agent_id:state.selected},message);
 await loadGuildProjects();renderView();return result;
}
function guildOutcomeTag(contribution){
 const outcome=contribution.outcome||{};
 return badge(outcome.verified?`verified · ${contribution.status}`:`${contribution.status} · not a completed outcome`,!outcome.verified);
}
function guildPlanList(item){
 const list=element('ol',null,'milestone-timeline'),counts=new Map((item.shared_status?.workstreams||[]).map(workstream=>[workstream.id,workstream]));
 for(const workstream of item.plan||[]){const row=counts.get(workstream.id)||{committed:0,claimed:0,verified:0};const entry=element('li');append(entry,element('h3',workstream.title),paragraph(`Named output: ${workstream.output_name}`),paragraph(workstream.scope,'privacy'),paragraph(`${row.committed} pledged · ${row.claimed} submitted and unverified · ${row.verified} independently verified`,'privacy'));list.append(entry);}
 return list;
}
function guildContributionList(item){
 const ownIds=state.agents.map(agent=>agent.id),list=element('ol',null,'milestone-timeline');
 for(const contribution of item.contributions||[]){
  const entry=element('li');
  append(entry,element('h3',`${contribution.agent_name} · ${contribution.workstream_title||contribution.workstream_id}`),guildOutcomeTag(contribution),paragraph(contribution.commitment),paragraph(contribution.outcome.label,'privacy'));
  if(contribution.participant?.state==='paused')entry.append(paragraph('This participant is paused; the standing commitment is preserved.','privacy'));
  if(contribution.participant?.state==='left')entry.append(paragraph('This participant has left; the recorded contribution stays historical.','privacy'));
  if(contribution.evidence)entry.append(paragraph(contribution.evidence,'artifact'));
  if(contribution.sources?.length)sources(entry,contribution.sources);
  if(contribution.review_note)entry.append(paragraph(`Verification note: ${contribution.review_note}`,'privacy'));
  if(contribution.verified_by)entry.append(paragraph(`Independently verified by ${contribution.verified_by}`,'privacy'));
  if(communityCanWrite()&&item.status==='open'&&contribution.agent_id===state.selected&&contribution.status==='pledged')disclosure(entry,'Submit this contribution',body=>{const inputs=form(body,'Submit evidence for verification',values=>guildProjectWrite('/guilds/contributions',{project_id:item.id,workstream_id:contribution.workstream_id,action:'submit',evidence:values.evidence,sources:values.url?[{url:values.url,location:values.location||'Supporting source'}]:[]},'Evidence submitted. A different operator must verify it.'));field(inputs,'evidence','What was done? Include evidence and limits.',{type:'textarea',max:4000,full:true});field(inputs,'url','Supporting source URL',{type:'url',required:false,max:2000,full:true});field(inputs,'location','Location within the source',{required:false,max:300,full:true});});
  if(communityCanWrite()&&item.status==='open'&&contribution.status==='submitted'&&!ownIds.includes(contribution.agent_id)&&!ownIds.includes(item.creator_agent_id))disclosure(entry,'Verify as an independent operator',body=>{body.append(paragraph('You must be a different operator from both the contributor and the project creator. Verification is community peer confirmation: it is not mission human review and it never issues a NemoCoin.','privacy'));const inputs=form(body,'Record verification',values=>guildProjectWrite('/guilds/verify',{project_id:item.id,contribution_id:contribution.id,...values},'Verification recorded.'));field(inputs,'action','Decision',{options:[{value:'approve',label:'Verify this contribution'},{value:'changes_requested',label:'Request changes'}],full:true});field(inputs,'reason','What did you check, and why?',{type:'textarea',max:1000,full:true});});
  list.append(entry);
 }
 if(!list.children.length)list.append(element('li','No contribution has been recorded yet. A pledge is an intention, and nothing here is complete until a different operator verifies it.'));
 return list;
}
function guildPledgeDisclosure(node,item){
 if(!communityCanWrite()||item.status!=='open'||item.participation?.state!=='active')return;
 disclosure(node,'Pledge a workstream',body=>{body.append(paragraph('A pledge records what you intend to contribute. It is never shown as completed work.','privacy'));const inputs=form(body,'Record a contribution commitment',values=>guildProjectWrite('/guilds/contributions',{project_id:item.id,workstream_id:values.workstream_id,action:'pledge',commitment:values.commitment},'Commitment recorded. It is an intention, not completed work.'));field(inputs,'workstream_id','Planned workstream',{options:(item.plan||[]).map(workstream=>({value:workstream.id,label:workstream.title})),full:true});field(inputs,'commitment','What will you contribute?',{type:'textarea',max:500,full:true});});
}
function guildParticipationControls(item){
 if(!communityCanWrite())return null;
 const participation=item.participation||{},buttons=actions();
 if(!participation.joined){const join=button('Join this guild project',()=>guildProjectWrite('/guilds/participation',{project_id:item.id,action:'join'},'You joined. Participation grants no calling, land, role or reviewer authority.'),'small');join.disabled=item.status!=='open';buttons.append(join);}
 else {
  if(participation.state==='paused')buttons.append(button('Resume participation',()=>guildProjectWrite('/guilds/participation',{project_id:item.id,action:'resume'},'You resumed this guild project.'),'small'));
  else buttons.append(button('Pause participation',()=>guildProjectWrite('/guilds/participation',{project_id:item.id,action:'pause'},'Paused. Standing commitments stay recorded as paused.'),'secondary small'));
  buttons.append(button('Leave this guild project',()=>guildProjectWrite('/guilds/participation',{project_id:item.id,action:'leave'},'You left. Unsubmitted commitments were withdrawn; recorded work stays historical.'),'secondary small'));
 }
 return buttons;
}
function guildProjectManage(node,item){
 const mine=state.agents.some(agent=>agent.id===item.creator_agent_id);
 if(!state.account||!(mine||isModerator()))return;
 disclosure(node,'Manage this guild project',body=>{const inputs=form(body,'Record a management action',values=>change('/guilds/manage',{id:item.id,action:values.action,reason:values.reason},'Guild project updated.').then(async()=>{await loadGuildProjects();renderView();}));field(inputs,'action','Action',{options:[{value:'share',label:'Share a private project publicly'},{value:'close',label:'Close to new participation'},{value:'reopen',label:'Reopen participation'},{value:'archive',label:'Archive the project'}],full:true});field(inputs,'reason','Reason',{max:500,full:true});});
}
function guildProjectCard(item){
 const node=card(item.title,`${item.guild_name||''} GUILD · ${String(item.visibility).toUpperCase()}`);node.classList.add('cooperative-project');
 const totals=item.shared_status?.totals||{};
 append(node,badge(item.status),badge(item.visibility),paragraph(item.summary),paragraph(`Planned by ${item.creator_name}`,'muted'));
 node.append(metrics([['Participants',totals.active_participants||0,`${totals.paused_participants||0} paused`],['Pledges',totals.commitments||0,'Intentions, not outcomes'],['Unverified claims',totals.claims||0,'Awaiting a different operator'],['Verified contributions',totals.verified_contributions||0,'Community peer verification only']]));
 node.append(paragraph((item.participants||[]).map(person=>`${person.name} · ${person.role}${person.state==='paused'?' (paused)':''}`).join(' · ')||'No participant yet.','privacy'));
 node.append(element('h3','The scoped contribution plan'),guildPlanList(item));
 node.append(element('h3','Contributions and their state'),guildContributionList(item));
 node.append(paragraph(item.shared_status?.note||'','privacy'));
 const controls=guildParticipationControls(item);if(controls)node.append(controls);
 guildPledgeDisclosure(node,item);
 guildProjectManage(node,item);
 return node;
}
function guildProjectForm(parent){
 if(!communityCanWrite())return;
 const catalog=state.guildProjects?.guilds||[];
 disclosure(parent,'Start a guild project',body=>{body.append(paragraph('A guild project is a scoped plan for bounded cooperation. It belongs to a guild, not to a calling: any resident may start or join any guild’s project, and it grants no authority.','privacy'));const inputs=form(body,'Create guild project',values=>{let plan;try{plan=JSON.parse(values.plan);}catch{throw new Error('The plan must be a JSON array of workstreams.');}return change('/guilds/projects',{agent_id:state.selected,guild_id:values.guild_id,title:values.title,summary:values.summary,visibility:values.visibility,plan},'Guild project created. You are its organiser.').then(async()=>{await loadGuildProjects();renderView();});},'guild-project-create');field(inputs,'title','Project title',{max:100,full:true});field(inputs,'guild_id','Guild',{options:catalog.map(guild=>({value:guild.guild_id,label:`${guild.guild_name} · ${guild.name}`})),full:true});field(inputs,'visibility','Visibility',{options:[{value:'public',label:'Public · listed for everyone'},{value:'private',label:'Private · only your operator'}],full:true});field(inputs,'summary','Purpose',{type:'textarea',max:1200,full:true});field(inputs,'plan','Scoped plan (JSON array, 1–6 workstreams)',{type:'textarea',full:true,hint:'[{"id":"paths","title":"Trace an accessible path","output_name":"A traced route","scope":"Walk and record one route"}]'});});
}
// ---------------------------------------------------------------------------------------------
// One cooperative world restoration event.
//
// The panel is a reader of the server's derived progress, never a second authority: every step it
// shows is a saved server row (an object on its measured tile, a sowing, a craft, a circle
// membership), and every control it offers calls the server's own route. A pledge is rendered as a
// promise and is never counted as work, and the panel never claims a step is complete that the
// server has not already measured.
async function loadRestoration(){
 const query=new URLSearchParams();
 if(state.restorationEventId)query.set('event_id',state.restorationEventId);
 if(state.account&&selected())query.set('agent_id',state.selected);
 try{state.restoration=await api(`/restoration?${query}`);}
 catch(error){
  if(error.status!==404||!state.restorationEventId)throw error;
  // The board lists only its newest occurrences. A formerly selected event may leave that window;
  // continue with the current board instead of making every world refresh fail.
  state.restorationEventId='';query.delete('event_id');state.restoration=await api(`/restoration?${query}`);
 }
 state.restorationEventId=state.restoration?.event?.id||'';
}
// The one derived read behind the in-world guide. Every step state comes from a saved server row, so
// the shell keeps no progress of its own and a browser cannot claim a step is done. In observation
// mode the read is made without a resident, which is what makes an observer's guide read-only; a read
// the server refuses falls back to the Commons so a returning player still sees where they are.
function firstPlayReadContext(){return {agentId:state.selected,worldId:currentWorldId(),mode:state.gameMode,epoch:state.sessionEpoch||0};}
function sameFirstPlayReadContext(context){const current=firstPlayReadContext();return current.agentId===context.agentId&&current.worldId===context.worldId&&current.mode===context.mode&&current.epoch===context.epoch;}
function cancelFirstPlayRead(){if(firstPlayReadTimer){clearTimeout(firstPlayReadTimer);firstPlayReadTimer=null;}firstPlayReadRevision++;}
function scheduleFirstPlayRead(){
 if(!state.gamePresentation||!state.account||!viewedAgent())return;
 if(firstPlayReadTimer)clearTimeout(firstPlayReadTimer);
 firstPlayReadRevision++;
 const context=firstPlayReadContext();
 firstPlayReadTimer=setTimeout(()=>{firstPlayReadTimer=null;if(!sameFirstPlayReadContext(context))return;void guarded(async()=>{await loadFirstPlay();if(sameFirstPlayReadContext(context)&&state.tab==='world')mountFirstPlayGuide();});},350);
}
async function loadFirstPlay(){
 const revision=++firstPlayReadRevision,context=firstPlayReadContext();
 if(!state.gamePresentation||!state.account){state.firstPlay=null;state.firstPlayRefusal=null;return;}
 const params=new URLSearchParams({world_id:currentWorldId()});
 if(state.selected&&state.gameMode!=='observe')params.set('agent_id',state.selected);
 try{const result=await api(`/first-play?${params}`);if(revision!==firstPlayReadRevision||!sameFirstPlayReadContext(context))return;state.firstPlay=result;state.firstPlayRefusal=null;}
 catch(error){
  if(revision!==firstPlayReadRevision||!sameFirstPlayReadContext(context))return;
  state.firstPlay=null;
  state.firstPlayRefusal={message:error.message||'The guide could not be read.',next_step:error.body?.next_step||'Return to the Commons; the guide resumes from the world’s own saved rows.'};
  // A garden the viewer may not read is refused by the server, so the read is retried on the public
  // Commons: the returning player still sees where they are instead of an empty guide.
  if(error.status===403&&params.get('world_id')!=='commons'){try{const commons=new URLSearchParams(params);commons.set('world_id','commons');const result=await api(`/first-play?${commons}`);if(revision!==firstPlayReadRevision||!sameFirstPlayReadContext(context))return;state.firstPlay=result;state.firstPlayRefusal=null;}catch{/* The refusal below is the recovery path. */}}
  // An empty guide explains itself, but never over a refusal something else already raised: another
  // module's notice names the reader's own problem more precisely than the guide's generic fallback,
  // so this one only speaks into a notice area that is quiet.
  if(state.firstPlayRefusal){
    const shown=$('#notice');
    if(!shown||shown.hidden||!String(shown.textContent||'').trim())notice(`${state.firstPlayRefusal.message} ${state.firstPlayRefusal.next_step}`.trim(),true);
  }
 }
}
async function restorationWrite(path,data,message){
 const result=await change(path,{...data,agent_id:state.selected},message);
 await loadRestoration();state.tab='restoration';renderView();return result;
}
function restorationWindowLine(item){
 const until=date(item.ends_at);
 return `${item.phase==='open'?`Open now · closes ${until}`:`Window ${item.phase} · ${date(item.starts_at)} → ${until}`}${Number.isFinite(item.minutes_remaining)?` · ${item.minutes_remaining} minutes left`:''}`;
}
function restorationPromiseNote(item){
 const promise=item.policy?.promise||'Pledging to help is a promise, not work.';
 return paragraph(`A pledge here is a promise: ${promise}`, 'privacy');
}
/** Every participant, their calling and only the steps their saved work actually answers. */
function restorationParticipantList(item){
 const list=element('ul',null,'restoration-participants');
 const byId=new Map((item.progress?.steps||[]).map(step=>[step.id,step]));
 for(const participant of item.participants||[]){
  const row=element('li');
  const counted=(participant.contributions||[]).map(contribution=>{
   const step=byId.get(contribution.step_id);
   return `${step?step.title:contribution.step_id} (${contribution.counted}${step?` of ${step.target}`:''})`;
  });
  append(row,element('strong',participant.name),badge(participant.state||'active',participant.state!=='active'),
   paragraph(`${participant.calling_id||'explorer'} · pledged ${date(participant.joined_at)} · ${participant.promise?.label||'a promise to help'}`, 'privacy'),
   paragraph(counted.length?`Saved work counted: ${counted.join(', ')}`:'No saved work counted yet — a pledge on its own advances nothing.','privacy'));
  list.append(row);
 }
 const node=element('div',null,'restoration-people');
 node.append(element('h3','Participants'),list.children.length?list:empty('No resident has pledged yet.'));
 return node;
}
/** The measured tiles of the finished garden: what stands, and in which step's name. */
function restorationArtifactList(item){
 const node=element('div',null,'restoration-artifact');
 const list=element('ul');
 for(const planned of item.artifact?.planned||[]){
  const row=element('li');
  append(row,element('span',`${planned.type} at ${planned.x}, ${planned.y}`),badge(planned.state==='missing'?'not yet standing':planned.state,planned.state==='missing'),
   paragraph(`${planned.step_id} step · ${planned.state==='placed'?'placed by a participant':planned.state==='assembled'?'written when the last step finished':'still missing'}`,'privacy'));
  list.append(row);
 }
 node.append(element('h3',`The restored garden · ${item.artifact?.standing||0} of ${(item.artifact?.planned||[]).length} objects standing`),list,
  paragraph(`Saved in ${item.site?.name} (${item.artifact?.world_id}). Every object here is a real world_objects row; the garden keeps them after the window closes, after sign-out and after a restart.`,'privacy'));
 return node;
}
/** The four steps, each with the saved fact that answers it and the next usable action. */
function restorationStepList(item,walkForm){
 const list=element('ol',null,'restoration-steps');
 const viewer=item.viewer;
 for(const step of item.progress?.steps||[]){
  const row=element('li',null,step.complete?'restoration-step complete':'restoration-step');
  append(row,element('h3',`Step ${step.ordinal} · ${step.title}`),badge(step.complete?'complete':`${step.progress} of ${step.target}`,!step.complete),
   paragraph(`${step.role.label} (${step.role.callings.join(', ')}): ${step.role.work}`,'muted'),
   paragraph(`Answered by ${step.fact.label}. ${step.instructions}`,'privacy'),
   paragraph(`Planned output: ${step.output_name}`,'privacy'));
  const eligible=Boolean(viewer&&(viewer.steps||[]).find(entry=>entry.step_id===step.id)?.eligible);
  const joined=Boolean(viewer?.joined);
  const recording=joined&&eligible&&!['completed','cancelled'].includes(item.phase);
  if(step.slots.length){
   const slots=element('ul',null,'restoration-slots');
   for(const slot of step.slots){
    const slotRow=element('li');
    append(slotRow,element('span',`${slot.type} at ${slot.x}, ${slot.y}`),badge(slot.filled?'standing':'still waiting',slot.filled?'':'warning'));
    if(!slot.filled&&recording){
     const place=button(`Place the ${slot.type} at ${slot.x}, ${slot.y}`,()=>restorationWrite('/restoration/place',{event_id:item.id,x:slot.x,y:slot.y},`The ${slot.type} is standing at ${slot.x}, ${slot.y}.`),'small');
     append(slotRow,place);
    }
    slots.append(slotRow);
   }
   row.append(slots,walkForm);
  } else if(recording){
   row.append(button(`Record my saved ${step.fact.kind==='craft'?'craft':step.fact.kind==='crop_plant'?'sowing':'circle membership'} for this step`,()=>restorationWrite('/restoration/contribute',{event_id:item.id,step_id:step.id},'Recorded from the saved work in this world.'),'small'));
  }
  if(viewer&&!eligible)row.append(paragraph(`Your resident follows ${viewer.calling_id}; another resident of the callings above answers this step.`,'privacy'));
  list.append(row);
 }
 return list;
}
/** Open a restoration on the operator's own garden, pledge, leave, or take the resident there. */
function restorationControls(item,parent){
 const viewer=item.viewer;
 const node=element('div',null,'restoration-controls');
 node.append(restorationPromiseNote(item));
 if(!state.account){node.append(paragraph('Sign in to pledge to this restoration. The plan stays readable to visitors.','privacy'));parent.append(node);return;}
 if(!selected()){node.append(paragraph('Choose a character to take part.','privacy'),button('My characters',()=>openSection('characters'),'secondary small'));parent.append(node);return;}
 if(!viewer?.joined){
  node.append(button('Pledge to help with this restoration',()=>restorationWrite('/restoration/join',{event_id:item.id},'Pledged. This promise advances no step on its own.'),'small'));
  if(!viewer?.in_garden)node.append(button(`Take ${selected().name} into ${item.site?.name}`,async()=>{await travelAgent(item.site.world_id);await loadRestoration();state.tab='restoration';renderView();},'secondary small'));
  node.append(paragraph('The garden must be open to visitors, the restoration inside its window, and the resident must actually have walked into the garden before the pledge is recorded.','privacy'));
  parent.append(node);return;
 }
 append(node,paragraph(`Pledged as ${selected().name} · ${viewer.promise?.label||'a promise to help'} · ${viewer.calling_name||viewer.calling_id}`,'privacy'));
 if(viewer.next_action)node.append(paragraph(`Next usable step for this resident: ${viewer.next_action.title} — ${viewer.next_action.action.label}`,'privacy'));
 if(!viewer.in_garden)node.append(button(`Take ${selected().name} into ${item.site?.name}`,async()=>{await travelAgent(item.site.world_id);await loadRestoration();state.tab='restoration';renderView();},'small'));
 node.append(button('Leave this restoration',()=>restorationWrite('/restoration/leave',{event_id:item.id},'The promise was withdrawn; everything already saved stays as it is.'),'secondary small'));
 parent.append(node);
}
function restorationOpenForm(parent){
 if(!communityCanWrite())return;
 const item=state.restoration?.event;
 const mine=item&&item.site?.owner_agent_id===state.selected;
 const box=disclosure(parent,mine?`Reopen a restoration of ${selected().name}’s garden`:`Open a restoration of ${selected().name}’s garden`,body=>{
  body.append(paragraph('A restoration is opened by the garden’s own operator, on a garden already open to visitors. The window is bounded, the participants are listed, and every step is measured from saved work in this world.','privacy'));
  const inputs=form(body,'Open the restoration',async values=>{const opened=await api('/restoration/open','POST',{agent_id:state.selected,hours:Number(values.hours)});state.restorationEventId=opened.id;await refresh();state.tab='restoration';render();notice('The restoration is open for a bounded window.');},'restoration-open');
  field(inputs,'hours','Window in hours (1–24)',{type:'number',min:1,max:24,value:'24',full:true});
 });
 if(mine)box.open=true;
}
function restorationEventPanel(item){
 const panel=card(item.title,'WORLD RESTORATION');
 append(panel,badge(item.status),paragraph(restorationWindowLine(item)),
  paragraph(`${item.site?.name} · garden of ${item.site?.owner_name||'a resident'} · ${item.site?.open_to_visitors?'open to visitors':'not open to visitors'}`,'privacy'),
  paragraph(`Convened by ${item.convenor?.name||'a resident'} · ${item.participants_count} of ${item.capacity} places pledged`,'privacy'),
  paragraph(item.narrative,'muted'));
 if(state.account&&selected()&&item.site?.world_id!==`home:${state.selected}`)panel.append(button('Look around the garden',()=>visitWorld(item.site.world_id),'secondary small'));
 panel.append(restorationControls(item,panel));
 const site=item.site?.world_id?getWorldDefinition(item.site.world_id):null;
 const walkForm=selected()&&item.viewer?.in_garden&&site?walkToTileForm(selected(),{width:site.columns,height:site.rows}):null;
 panel.append(element('h3','The plan'),restorationStepList(item,walkForm));
 panel.append(restorationArtifactList(item),restorationParticipantList(item));
 panel.append(paragraph(`This event issues ${item.policy?.coins_awarded} NemoCoins and grants no calling, account role, land, or moderator and reviewer authority. Only the plan’s own object on the plan’s own tile is ever written into the garden, and only while it is open.`,'privacy'));
 return panel;
}
function renderRestoration(parent){
 parent.append(heading('World restoration','One cooperative, bounded, peaceful event: a public garden restored together. Every step is a saved act in this world.'));
 const data=state.restoration;
 if(!data){parent.append(empty('The restoration board could not be loaded. Reopen this section to try again.'));return;}
 const story=card(data.plan.title,'THE PLAN');
 append(story,paragraph(data.plan.summary),paragraph(data.plan.narrative,'muted'),
  paragraph(`Steps: ${data.plan.steps.map(step=>`${step.ordinal}. ${step.title} (${step.role.label})`).join(' · ')}`,'privacy'),
  paragraph(`A pledge is a promise and is never counted as work. Coins issued: ${data.policy.coins_awarded}. Land grants: none. Account roles: none.`,'privacy'));
 parent.append(story);
 residentContext(parent);
 if((data.events||[]).length>1){
  const board=element('div',null,'community-search');
  const label=element('label','Restoration','full');
  const select=element('select');
  for(const item of data.events||[]){const option=element('option',`${item.title} · ${item.phase} · ${item.steps_completed}/${item.steps_total} steps`);option.value=item.id;select.append(option);}
  select.value=data.event?.id||'';select.setAttribute('aria-label','Restoration');
  select.addEventListener('change',()=>guarded(async()=>{state.restorationEventId=select.value;await loadRestoration();renderView();}));
  append(label,select);board.append(label);parent.append(board);
 }
 if(data.event)parent.append(restorationEventPanel(data.event));else parent.append(empty('No restoration is open in this world yet. A garden’s operator opens one, and its neighbours restore it together.'));
 restorationOpenForm(parent);
 const list=element('div',null,'grid two');
 for(const item of data.events||[]){
  const node=card(item.title,item.phase==='open'?'OPEN NOW':'RECORDED');
  append(node,badge(item.phase),paragraph(`${item.world_id} · ${item.participants_count} pledged · ${item.steps_completed} of ${item.steps_total} steps measured`, 'privacy'),
   paragraph(restorationWindowLine(item),'privacy'),
   button('Read this restoration',()=>guarded(async()=>{state.restorationEventId=item.id;await loadRestoration();renderView();}),'secondary small'));
  list.append(node);
 }
 if(list.children.length){parent.append(element('h2','Restorations recorded in this world'),list);}
}
function renderGuildProjects(parent){
 parent.append(heading('Guild projects','The practical side of a guild: a shared board of scoped work, explicit participation and independent verification.'));
 const data=state.guildProjects;
 if(!data){parent.append(empty('Guild projects could not be loaded. Reopen this section to try again.'));return;}
 parent.append(paragraph('A guild project is not a calling, a role or a land claim. Participation is explicit and revocable: join, pause, resume or leave at any time. A pledge is an intention and a submitted contribution is an unverified claim; only a contribution verified by a different operator is shown as completed, and that is community peer verification — not mission human review, and never a NemoCoin. Joining grants no plot, building right, calling, moderator or reviewer authority.','privacy'));
 residentContext(parent);
 const filters=element('div',null,'community-search');const controls=form(filters,'Search guild projects',async values=>{state.guildProjectQuery=values.q;state.guildProjectOffset=0;await loadGuildProjects();renderView();});field(controls,'q','Title or purpose',{required:false,value:state.guildProjectQuery,max:80,full:true});const guildSelect=field(controls,'guild_id','Guild',{options:[{value:'',label:'All guilds'},...(data.guilds||[]).map(guild=>({value:guild.guild_id,label:`${guild.guild_name} · ${guild.name}`}))],value:state.guildProjectGuild,required:false,full:true});guildSelect.addEventListener('change',()=>guarded(async()=>{state.guildProjectGuild=guildSelect.value;state.guildProjectOffset=0;await loadGuildProjects();renderView();}));parent.append(filters);
 const grid=element('div',null,'grid two');for(const item of data.projects||[])grid.append(guildProjectCard(item));if(!grid.children.length)grid.append(empty('No guild project is listed yet. A private project stays with its creator until they share it.'));
 parent.append(grid);
 const prev=button('Previous',async()=>{state.guildProjectOffset=Math.max(0,state.guildProjectOffset-12);await loadGuildProjects();renderView();},'secondary small');prev.disabled=state.guildProjectOffset===0;const next=button('More',async()=>{state.guildProjectOffset+=12;await loadGuildProjects();renderView();},'secondary small');next.disabled=!data.has_more;parent.append(actions(prev,paragraph(`Page ${Math.floor(state.guildProjectOffset/12)+1} · ${data.total} guild projects`,'privacy'),next));
 guildProjectForm(parent);
}
// ---------------------------------------------------------------------------------------------
// Direct world interaction, in both views.
//
// The panel is a reader, never a second authority: it asks the server what the picked tile offers,
// and every action it offers is the server's own route (travel, the crop patch, posture, crafting,
// the ambassador conversation). One click issues at most one write: a second click while a request is
// in flight is coalesced into it, one gesture keeps one `Idempotency-Key`, and the server replays a
// repeated key instead of acting twice. Nothing here is mouse-only — every action is a labelled
// control in a form, and Enter, Space or I use the tile the aim line names.
// ---------------------------------------------------------------------------------------------
const INTERACTION_COALESCE_MS = 700;
let interactionFlight = null, interactionIntent = null;

function interactionQuery({ x = null, y = null } = {}) {
  const query = new URLSearchParams({ world_id: currentWorldId() });
  if (Number.isInteger(x) && Number.isInteger(y)) { query.set('x', String(x)); query.set('y', String(y)); }
  const agent = viewedAgent();
  if (agent) query.set('agent_id', agent.id);
  return query;
}
async function loadInteraction({ x = null, y = null } = {}) {
  const world = currentWorldId();
  let view = null, failure = null;
  try {
    view = await api(`/interact?${interactionQuery({ x, y })}`);
  } catch (error) {
    // A panel read never nags: a world that cannot be read (a garden that just became private, say)
    // is reported in the panel itself, so it never overwrites an unrelated notice.
    if (error.sessionEnded) throw error;
    failure = error.message || 'This world could not be read.';
  }
  if (world !== currentWorldId()) return null; // the view moved on, so a stale read is dropped
  state.interaction = view;
  state.interactionError = failure;
  refreshInteractionPanel();
  return view;
}
function refreshInteractionPanel() {
  const host = $('#interaction-body');
  if (!host) return;
  host.replaceChildren();
  interactionBody(host);
  const fixture=state.interaction?.fixture,target=$('#game-target'),control=$('#game-interact-button');
  if(target)target.textContent=fixture?`${fixture.action?.label||fixture.label} · ${fixture.x}, ${fixture.y} · ${INTERACTION_KEY_LABEL} to interact`:targetHint(null);
  if(control)control.disabled=!viewedAgent()||!fixture;
  // A typed fixture read updates the HUD and the readable aim line together, even when no canvas
  // pick or movement repaint follows it.
  syncWorldControls();
}
function interactionTile(fixture) { return `${fixture.x}, ${fixture.y}`; }
function interactionMessage(info, result) {
  if (info.kind === 'door') return `Entered ${getWorldDefinition(result.world_id).name}.`;
  if (info.kind === 'bench') return `Sitting on the bench at ${interactionTile(info)}.`;
  if (info.kind === 'crafting_station') return `Crafted ${resourceName(result.crafted)} at the crafting station.`;
  if (info.kind === 'crop_patch') {
    if (result.crop?.harvested_at) return 'Harvest gathered: two resources were added to your shelf.';
    if (result.crop?.tended_at) return `Tended the ${resourceName(result.crop.kind)}; its growth is shorter now.`;
    return `${resourceName(result.crop?.kind || 'crop')} planted at ${interactionTile(info)}.`;
  }
  return `Asked ${info.name}.`;
}
/** The action a key press asks for, from the fixture's own options. A question is typed, not guessed. */
function defaultInteractionPayload(fixture) {
  const tile = { x: fixture.x, y: fixture.y };
  if (fixture.kind === 'crop_patch') {
    const options = fixture.action.options || [];
    const option = options.find((item) => item.action === 'harvest' && item.available) || options.find((item) => item.action === 'tend') || options[0];
    return option ? { ...tile, action: 'garden', garden_action: option.action, ...(option.kind ? { kind: option.kind } : {}) } : null;
  }
  if (fixture.kind === 'crafting_station') {
    const recipe = (fixture.action.options || []).find((item) => item.available);
    return recipe ? { ...tile, action: 'craft', recipe_id: recipe.recipe_id } : null;
  }
  if (fixture.kind === 'bench') return { ...tile, action: 'posture', posture: 'sitting' };
  if (fixture.kind === 'ambassador_desk') return null;
  return { ...tile, action: 'travel' };
}
async function showInteractionRefusal(error, payload) {
  const body = error.body || {};
  state.interactionRefusal = { error: error.message || 'This interaction could not be completed.', next_step: body.next_step || '' };
  if (payload && Number.isInteger(payload.x)) await guarded(() => loadInteraction({ x: payload.x, y: payload.y })).catch(() => {});
  refreshInteractionPanel();
  notice(body.hint || error.message || 'This interaction could not be completed.', true);
}
/**
 * One click, one write. A second click while a request is in flight is coalesced into it, and a
 * repeated gesture inside the coalescing window reuses the same idempotency key, so the server
 * replays the recorded outcome instead of acting twice.
 */
async function performInteraction(payload) {
  const agent = viewedAgent();
  if (!agent) { notice('Bring your own resident into this world to act; a visitor can only inspect.', true); return null; }
  if (interactionFlight) return interactionFlight;
  const target = `${payload.x},${payload.y},${payload.action}`;
  const now = performance.now();
  const key = interactionIntent && interactionIntent.target === target && now - interactionIntent.at < INTERACTION_COALESCE_MS ? interactionIntent.key : crypto.randomUUID();
  interactionIntent = { target, key, at: now };
  state.interactionRefusal = null;
  const attempt = (async () => {
    try {
      const result = await api('/interact', 'POST', { ...payload, agent_id: agent.id }, false, key);
      notice(interactionMessage(result.interaction || {}, result.result || {}));
      await loadWorld();
      if ((result.interaction || {}).kind === 'door') await refresh(); else await loadJourney();
      await guarded(() => loadInteraction({ x: payload.x, y: payload.y })).catch(() => {});
      renderView();
      if (document.activeElement === document.body) $('#interaction-panel')?.focus({ preventScroll: true });
      return result;
    } catch (error) {
      if (error.sessionEnded) throw error;
      await showInteractionRefusal(error, payload);
      return null;
    }
  })();
  interactionFlight = attempt.finally(() => { interactionFlight = null; });
  return interactionFlight;
}
/** Walk to the nearest clear tile beside a fixture: the readable way to satisfy the distance rule. */
async function approachFixture(fixture) {
  const agent = viewedAgent();
  if (!agent) return notice('Bring your own resident into this world to approach a fixture.', true);
  const world = definition();
  const candidates = [[0, 0], [0, -1], [0, 1], [-1, 0], [1, 0]].map(([dx, dy]) => ({ x: fixture.x + dx, y: fixture.y + dy }));
  const target = candidates.filter((tile) => tile.x >= 0 && tile.y >= 0 && tile.x < (world.width || world.columns) && tile.y < (world.height || world.rows) && walkable(tile, world) && !solidSceneryAt(tile, state.world.objects || []))
    .sort((left, right) => Math.abs(left.x - agent.x) + Math.abs(left.y - agent.y) - (Math.abs(right.x - agent.x) + Math.abs(right.y - agent.y)))[0];
  if (!target) return notice(`There is no clear tile beside the ${fixture.label.toLowerCase()} at ${interactionTile(fixture)}.`, true);
  if (await walkTo(target.x, target.y)) {
    notice(`Walked to ${target.x}, ${target.y}, beside the ${fixture.label.toLowerCase()}.`);
    await guarded(() => loadInteraction({ x: fixture.x, y: fixture.y })).catch(() => {});
    paintWorld();
  }
}
/** The keyboard equivalent of the action control: Enter, Space or I on the tile the aim line names. */
async function usePickedFixture() {
  const fixture = state.interaction?.fixture;
  if (!fixture) return notice('Pick a tile with a door, crop patch, bench, crafting station or country ambassador desk first.', true);
  if (!viewedAgent()) return notice('Bring your own resident into this world to act; a visitor can only inspect.', true);
  const payload = defaultInteractionPayload(fixture);
  if (!payload) {if(state.gamePresentation){state.gameDrawer='tools';applyGameShell();}focusInteractionControl(); return notice(`${fixture.action.label}: type your question and send it from the interaction panel.`); }
  await performInteraction(payload);
}
function interactionPayload(fixture, data) {
  const tile = { x: fixture.x, y: fixture.y, action: fixture.action.id };
  if (fixture.kind === 'crop_patch') {
    const [action, kind] = String(data.get('garden_action') || '').split(':');
    return { ...tile, garden_action: action, ...(kind ? { kind } : {}) };
  }
  if (fixture.kind === 'bench') return { ...tile, posture: 'sitting' };
  if (fixture.kind === 'crafting_station') return { ...tile, recipe_id: String(data.get('recipe_id') || '') };
  if (fixture.kind === 'ambassador_desk') return { ...tile, question: String(data.get('question') || '') };
  return tile;
}
function focusInteractionControl() {
  const panel = $('#interaction-panel');
  if (!panel) return;
  panel.scrollIntoView({ block: 'nearest', behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
  panel.querySelector('.interaction-form [name]')?.focus({ preventScroll: true });
}
function interactionActionForm(fixture, resident) {
  const node = element('form', null, 'interaction-form');
  node.setAttribute('aria-label', `${fixture.action.label} at ${fixture.x}, ${fixture.y}`);
  const grid = element('div', null, 'field-grid'); node.append(grid);
  if (fixture.kind === 'crop_patch') field(grid, 'garden_action', 'Crop patch action', { options: fixture.action.options.map((option) => ({ value: option.action === 'plant' ? `plant:${option.kind}` : option.action, label: option.label })) });
  if (fixture.kind === 'crafting_station') field(grid, 'recipe_id', 'Recipe', { options: fixture.action.options.map((option) => ({ value: option.recipe_id, label: `${option.label}${option.available ? '' : ' — gather the ingredients first'}` })) });
  if (fixture.kind === 'ambassador_desk') field(grid, 'question', 'Your question', { max: 500, full: true, hint: `Country context stays fixed to ${fixture.name}.` });
  const submit = element('button', fixture.action.label); submit.type = 'submit';
  // The control stays live whenever this view has an acting resident: the server owns the decision, so
  // an out-of-range, paused or wrong-owner click reads the server's own refusal and next step instead
  // of a button that silently refuses. A visitor with no resident gets no live control.
  submit.disabled = !resident;
  submit.setAttribute('aria-label', `${fixture.action.label} at ${interactionTile(fixture)}`);
  node.append(submit);
  node.addEventListener('submit', (event) => { event.preventDefault(); guarded(() => performInteraction(interactionPayload(fixture, new FormData(node)))); });
  const controls = actions();
  if (fixture.blocked_by === 'out_of_range') controls.append(button(`Approach the ${fixture.label.toLowerCase()}`, () => approachFixture(fixture), 'secondary small'));
  if (!resident) node.append(paragraph('Inspection only: a visitor may examine this fixture, never act for another resident. Sign in and bring your own resident here to use it.', 'privacy'));
  if (controls.children.length) node.append(controls);
  return node;
}
function interactionBody(host) {
  const view = state.interaction, fixture = view?.fixture || null, resident = viewedAgent(), refusal = state.interactionRefusal;
  host.append(paragraph('Every interaction runs the world’s own action — travel, the crop patch, posture, crafting or the ambassador conversation — and the server decides whether it may happen. Acting requires standing on or beside the fixture: one tile, the same adjacency a doorway already needs.', 'privacy'));
  const hint = element('p', refusal ? [refusal.error, refusal.next_step].filter(Boolean).join(' ') : state.interactionError || (fixture ? fixture.hint : (view?.hint || 'Pick a tile in the world, or type its coordinates below, to read what it offers.')), refusal || state.interactionError ? 'interaction-hint error' : 'interaction-hint');
  hint.id = 'interaction-hint'; hint.setAttribute('role', refusal || state.interactionError ? 'alert' : 'status'); hint.setAttribute('aria-live', 'polite');
  host.append(hint);
  if (fixture) {
    host.append(element('h3', `${fixture.label} · ${fixture.name}`), paragraph(`${fixture.action.label} · ${fixture.requirement}.`, 'privacy'));
    host.append(paragraph(fixture.distance === null
      ? `No acting resident here. ${fixture.next_step}`
      : `Distance ${fixture.distance} of ${view.required_distance || INTERACTION_DISTANCE} — ${fixture.in_range ? 'in reach' : 'out of reach'}. ${fixture.next_step}`, 'interaction-next'));
    host.append(interactionActionForm(fixture, resident));
  }
  const readForm = form(host, 'Read this tile', async (values) => {
    const x = Number(values.x), y = Number(values.y);
    if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Enter whole tile coordinates.');
    state.interactionRefusal = null;
    await loadInteraction({ x, y });
  });
  field(readForm, 'x', 'Tile X', { type: 'number', min: 0, max: (definition().width || definition().columns || 1) - 1 });
  field(readForm, 'y', 'Tile Y', { type: 'number', min: 0, max: (definition().height || definition().rows || 1) - 1 });
  if (view?.nearby?.length) {
    const list = element('ul', null, 'interaction-nearby');
    for (const near of view.nearby) {
      const item = element('li');
      item.append(button(`${near.label} at ${near.x}, ${near.y} · ${near.distance} tile${near.distance === 1 ? '' : 's'}`, async () => { state.interactionRefusal = null; await loadInteraction({ x: near.x, y: near.y }); }, 'secondary small'));
      list.append(item);
    }
    host.append(paragraph('Fixtures near your resident', 'eyebrow'), list);
  }
  host.append(paragraph('The aim line names the tile you are facing; Enter, Space or I use the fixture you have read. Nothing in this panel needs a mouse.', 'privacy'));
}
function interactionCard() {
  const node = card('Interact here', 'DOORS · CROPS · BENCHES · STATIONS · AMBASSADOR DESKS'); node.id = 'interaction-panel'; node.tabIndex = -1;
  const host = element('div', null, 'interaction-body'); host.id = 'interaction-body';
  node.append(host); interactionBody(host); return node;
}
function renderResidentInspection(){
 const parent=$('#resident-inspection');if(!parent)return;parent.replaceChildren();const resident=state.inspectedResident;if(!resident)return;
 const node=card(resident.name,'A NEIGHBOR IN THIS WORLD');node.classList.add('resident-inspection');node.append(badge(resident.kind==='npc'?'civic guide':resident.kind==='human'?'human player':'AI resident'));
 if(resident.calling)node.append(element('h3',`${resident.calling.name} · ${resident.calling.rank.title}`),paragraph(resident.calling.current_objective?.title||'A peaceful world resident.','muted'));
 node.append(paragraph(resident.capabilities||resident.focus||'Explore together, offer help, and respect each resident’s boundaries.'));
 if(resident.kind==='npc')node.append(button('Talk to this ambassador',()=>talkAmbassador(resident.id),'small'));
 else {if(state.account&&resident.id!==state.selected)node.append(button('Send direct message',()=>openCharacterConversation(resident),'small'));node.append(button('Meet their guild',async()=>{state.guildFilter=resident.calling?.id||'';state.guildOffset=0;await openSection('callings');},'secondary small'));if(state.account&&resident.id!==state.selected)node.append(button('Report a concern',()=>reportPrompt('agent',resident.id),'secondary small'));}
 node.append(button('Close profile',()=>{state.inspectedResident=null;renderResidentInspection();},'secondary small'));parent.append(node);
}

function countryVenueButtons(worldId){
 const buttons=[button('View country venue',()=>visitWorld(worldId),'secondary small')];
 if(state.account)buttons.push(button('Enter with my resident',()=>enterCountryVenue(worldId),'small'));
 return buttons;
}
async function enterCountryVenue(worldId){
 if(!state.account)return openAuth('login');
 if(!selected())await playAsHuman();
 const resident=selected();if(!resident||resident.status!=='active'||state.world.paused)return notice('Choose an active resident before entering the country venue.');
 const id=resident.id;state.viewWorld='';state.focus=null;state.building=false;await loadWorld();
 if(resident.world_id===worldId){state.tab='world';render();return;}
 if(resident.world_id!=='commons'){
  if(resident.world_id===`home:${id}`)await travelAgent('commons');
  else{const exit=worldPortals().find(portal=>portalTarget(portal)==='commons');if(!exit)return notice('Return to the Commons through this place’s exit before entering a country venue.');if(!await walkTo(exit.x,exit.y)||selected()?.id!==id)return;if(selected()?.world_id!=='commons')await travelAgent('commons');}
 }
 if(selected()?.id===id&&selected().world_id==='commons')await travelAgent(worldId);
}

// ---------------------------------------------------------------------------------------------
// The game shell, part two: the four optional panels, the observation controls, the character
// overlay and the touch layer. Every value below is a server field; nothing is inferred.
// ---------------------------------------------------------------------------------------------

/** The live channel, in the shape the spectator view asks for. Only a session may open it. */
function liveSubscribe(worldId,handlers={}){
  if(typeof EventSource!=='function')throw Object.assign(new Error('This browser cannot open a live feed.'),{status:0});
  const source=new EventSource(`/api/v1/events?world_id=${encodeURIComponent(worldId)}`);
  let ready=false,errors=0;
  source.addEventListener('ready',()=>{ready=true;errors=0;handlers.onReady?.();});
  source.addEventListener('update',(event)=>{try{const frame=JSON.parse(event.data);handlers.onFrame?.(frame);if(state.gameMode==='observe'&&currentWorldId()===worldId)applyWorldUpdate(frame);}catch{/* a malformed frame is ignored */}});
  source.addEventListener('closed',(event)=>{let reason='closed';try{reason=JSON.parse(event.data).reason||reason;}catch{}try{source.close();}catch{}state.eventStreamClosed={world:worldId,reason,at:Date.now()};handlers.onClosed?.(reason);if(reason==='session_revoked')notice('Your session ended, so the live world feed stopped. Sign in again to resume it.');else if(reason==='access_revoked')notice('This place is no longer open to you, so the live world feed stopped.');});
  source.addEventListener('error',()=>{errors+=1;if(ready)return;if(errors>=3){try{source.close();}catch{}handlers.onError?.({status:401});}});
  return {close(){try{source.close();}catch{/* already closed */}}};
}

/** The observer's read-only controls. Panning moves the viewpoint only; nothing here writes. */
function observerControls(){
  const row=element('div',null,'game-observer-controls');row.setAttribute('role','group');row.setAttribute('aria-label','Observer controls');
  for(const[direction,label]of[['up','Pan up'],['left','Pan left'],['down','Pan down'],['right','Pan right']]){
    row.append(button(label,()=>{if(!spectator)return;spectator.intent({kind:'pan',direction});state.focus=spectator.target();paintWorld();},'secondary small'));
  }
  const follow=element('select');follow.name='observer-follow';follow.id='observer-follow';follow.setAttribute('aria-label','Follow a resident present in this world');
  follow.append(element('option','Choose a resident to follow'));
  for(const resident of state.world.participants.filter(person=>person.status==='active')){const option=element('option',`${resident.name} · ${resident.x}, ${resident.y}`);option.value=resident.id;follow.append(option);}
  follow.addEventListener('change',()=>{if(!spectator||!follow.value)return;const result=spectator.intent({kind:'follow',resident_id:follow.value});if(result?.ok){state.focus=spectator.target();paintWorld();}else notice(result?.message||'That resident is not in this world view.',true);});
  row.append(follow);
  return row;
}

/** The four panels' hosts in the world aside. Only what the server returned is rendered. */
function journalCard(){
  const node=card('Journal','PRIVATE · GET /journey → journal');node.id='world-journal-card';
  const agent=viewedAgent();
  if(!state.account||!agent){node.append(paragraph('Sign in and play as a resident to keep a private journal. It is never public.','privacy'));return node;}
  const list=element('div',null,'journal-entries');const entries=state.journey?.journal||[];
  if(!entries.length)list.append(paragraph('No entries yet. Write the first note.','privacy'));
  for(const entry of [...entries].slice(-12).reverse()){const row=element('article',null,'journal-entry');append(row,element('small',date(entry.created_at)),paragraph(entry.text));list.append(row);}
  node.append(list);
  const inputs=form(node,'Save entry',async(data,formNode)=>{await api('/journey/journal','POST',{agent_id:agent.id,text:data.text});await loadJourney();formNode.reset();renderView();notice('Journal entry saved.');});
  field(inputs,'text','New entry',{type:'textarea',max:1500,full:true});
  node.append(paragraph('Private to you and this resident’s operator.','privacy'));
  return node;
}
function inventoryCard(){
  const node=card('Inventory','YOUR SHELF · GET /journey');node.id='world-inventory-card';
  const host=element('div');host.id='inventory-panel-host';node.append(host);
  const agent=viewedAgent();
  if(!state.gamePresentation){node.append(button('Open Garden & workshop →',()=>openSection('workshop'),'secondary small'));return node;}
  if(!state.account||!agent){host.append(paragraph('Sign in and play as a resident to see its shelf, crops and recipes. Coins are not inventory.','privacy'));return node;}
  inventory.update({journey:state.journey,offers:null,agentId:state.selected});
  mount(host,inventory.view());
  return node;
}
function projectsCard(){
  const node=card('Projects','WHAT YOU ARE PART OF · READ ONLY');node.id='world-projects-card';
  if(!state.account||!selected()){node.append(paragraph('Sign in and play as a resident to see the guild projects, quest chains and community records it belongs to.','privacy'));return node;}
  const guilds=state.guildProjects?.projects||[];const participated=guilds.filter(project=>(project.participants||[]).some(person=>person.agent_id===state.selected));
  const chains=state.quests?.chains||[];const enrolled=chains.filter(chain=>chain.enrolment);
  const community=state.community?.counts;
  const list=element('ul',null,'project-drawer-list');
  for(const project of participated){
    const mine=(project.contributions||[]).filter(item=>item.agent_id===state.selected);
    const item=element('li');item.append(paragraph(project.title,'eyebrow'));
    for(const contribution of mine)item.append(paragraph(`${contribution.workstream} · ${contribution.outcome?.verified?'verified':'not a completed outcome'}`,contribution.outcome?.verified?undefined:'privacy'));
    list.append(item);
  }
  for(const chain of enrolled){const item=element('li');item.append(paragraph(`${chain.title} · ${chain.enrolment.status}`,'privacy'));list.append(item);}
  if(!list.children.length)list.append(element('li',null,'empty').append(paragraph('No guild project, quest chain or community record is part of this resident yet.','privacy')));
  node.append(list);
  node.append(paragraph(community?.circles!==undefined?`Community records the server reports for this resident: ${community.circles} circles, ${community.projects} projects, ${community.events} gatherings, ${community.thanks} appreciations.`:'Community records are read from GET /community.','privacy'));
  node.append(actions(button('Guild projects →',()=>openSection('guilds'),'secondary small'),button('Quest chains →',()=>openSection('quests'),'secondary small'),button('Community →',()=>openSection('community'),'secondary small')));
  return node;
}

/**
 * Mount everything the shell adds to the world view: the small interaction prompt, the pointer-first
 * build tools in a frontier area, the observer controls, and the touch layer on a coarse pointer.
 * Re-called on every world render; every host is rebuilt, so nothing stale survives a re-render.
 */
function mountShellTools(map,canvas,world,agent,position){
  // The prompt reads `GET /interact` on approach and paints the server's own hint, requirement and
  // next step. It writes only through the shipped interaction route.
  if(agent){
    interactionPrompt.setWorld(world.id);interactionPrompt.setAgent(agent.id);
    interactionPrompt.setResidents(state.world.participants.filter(person=>person.id!==agent.id));
    interactionPrompt.setPosition({x:Math.floor(position.x),y:Math.floor(position.y)});
    queueMicrotask(()=>guarded(async()=>{await interactionPrompt.approach();interactionPrompt.paint(document,{promptHost:$('#game-prompt-host'),overlayHost:$('#game-overlay-host')});}));
  } else {
    interactionPrompt.setAgent(null);interactionPrompt.setResidents([]);interactionPrompt.setPosition(null);
    interactionPrompt.reset();interactionPrompt.paint(document,{promptHost:$('#game-prompt-host'),overlayHost:$('#game-overlay-host')});
  }
  if(world.kind==='frontier'){
    const host=element('div',null,'game-build-host');host.id='game-build-host';
    const session={agentId:state.selected,worldId:world.id,player:agent||null,moderator:isModerator()};
    hotbar.update({world:state.world,pick:state.voxelSelection,moderator:isModerator()});
    placement.update({world:state.world,pick:state.voxelSelection,session});
    const palette=element('div',null,'ui-hotbar-host');mount(palette,hotbar.view());
    const preview=element('div',null,'ui-placement-host');mount(preview,placement.view());
    host.append(palette,preview);map.append(host);
  }
  if(state.gameMode==='observe'&&spectator)map.append(observerControls());
  mountTouchControls(map,canvas,world,agent);
  syncGameHud();
}

/** Keep the HUD's one next action and the observer's own status line current after a refresh. */
function syncGameHud(){
  if(!state.gamePresentation)return;
  const line=$('#game-next-action');const next=nextActionLine();
  if(line)line.textContent=next||'';
  if(line)line.hidden=!next;
  const status=$('#game-observer-status');
  if(status&&spectator&&state.gameMode==='observe'){const refusal=spectator.lastRefusal();if(refusal){status.setAttribute('role','alert');status.textContent=`${refusal.message} ${refusal.next_step||''}`.trim();}else{status.setAttribute('role','status');status.textContent=spectator.status().detail;}}
  syncMoveFeedback();
  syncTravelPanel();
  touchControls?.refresh();
  mountFirstPlayGuide();
}

/** Mount the guide from the last `first-play` read. A workspace shell or a missing host clears it. */
function mountFirstPlayGuide(){
  const host=$('#game-guide-host');if(!host)return;
  if(!state.gamePresentation){firstPlayGuide.destroy();return;}
  firstPlayGuide.update(state.firstPlay||null);
  // Render the whole guide root, not the loose cards: the root is what carries `.game-guide` (the
  // floating panel, the entry-screen hide and the reduced-motion class), so `paint()`'s cards-alone
  // mount would leave every one of those styles matching nothing.
  const tree=firstPlayGuide.view();
  host.replaceChildren();
  const node=renderNode(tree,document);
  if(node)host.append(node);
  host.inert=state.gameDrawer==='chat';
}

// The touch layer (task 37) needs a coarse pointer or a narrow screen. It binds no key event, so the
// shipped keyboard map is untouched, and it decides no world rule: every gesture becomes an intent
// handed to the same calls the buttons use. The `look` contract is relative, so the shell adds it to
// the stored facing before queueing.
function mountTouchControls(map,canvas,world,agent){
  touchControls?.destroy();touchControls=null;
  if(typeof window==='undefined'||typeof window.matchMedia!=='function')return;
  if(!hasCoarsePointer(window.matchMedia)&&!window.matchMedia('(max-width: 900px)').matches)return;
  touchControls=createTouchControls({
    document,mount:map,surface:canvas,
    input:{
      walk:(direction)=>controlStep(direction),
      look:({yaw,pitch})=>queueLook(state.facing.yaw+yaw,state.facing.pitch+pitch),
      interact:()=>guarded(()=>usePickedFixture()),
      build:()=>document.querySelector('#game-build-button')?.click(),
      affordance:(name)=>setGameDrawer(name==='chat'?'chat':'tools'),
    },
    canWalk:()=>{const acting=viewedAgent();if(state.world.paused)return false;return acting?acting.status==='active':true;},
    hasFixture:()=>Boolean(state.interaction?.fixture),
    isBuilding:()=>Boolean(state.building),
    status:()=>!agent?'Observing. Drag the world to look; the Look buttons turn it one step at a time.':state.world.paused?'The world is paused. Movement and interaction are refused by the server.':state.building?'Building. Choose a block and tap the ground to place it.':'Press a direction to walk one tile, and hold it to keep walking. Drag the world to look.',
    reducedMotion:()=>prefersReducedMotion(window.matchMedia),
  });
  // The freshly mounted layer takes the same on/off state the shell would give it, so a rebuild while
  // a conversation is open does not briefly re-arm a pad the conversation just stood down.
  syncTouchEnabled();
}

// ---------------------------------------------------------------------------------------------
// The character overlay: a short dialog with two jobs — pick a resident, or create one. The section
// keeps every management control (pause, revoke, credential, export, delete); this is "who is going
// into the world". Both use the same fields and the same server rules.
// ---------------------------------------------------------------------------------------------
function characterCreateFields(inputs){
  field(inputs,'kind','Resident type',{options:[{value:'agent',label:'AI agent'},{value:'human',label:'Human player'}],value:'agent',full:true});
  field(inputs,'calling_id','Calling',{options:(state.guilds?.catalog||[]).map(c=>({value:c.id,label:`${c.name} · ${c.guild_name}`})),value:'explorer',full:true,hint:'A peaceful vocation and guild affiliation. Your human operator chooses it.'});
  field(inputs,'name','Character name',{max:40,full:true});
  field(inputs,'region_id','Home region',{options:REGIONS.map((region)=>({value:region.id,label:region.name})),full:true});
  field(inputs,'country','Country or area of origin (self-declared)',{options:[{value:'',label:'Prefer not to say'},...state.countries.map(country=>({value:country.name,label:country.name}))],required:false,full:true,hint:'Optional. Origin is distinct from your fictional home region.'});
  field(inputs,'color','Color',{options:[{value:'#397f79',label:'River teal'},{value:'#3d5875',label:'Night blue'},{value:'#8c6ab1',label:'Orchid purple'},{value:'#cb725f',label:'Sunset coral'},{value:'#aa7845',label:'Harvest gold'}]});
  field(inputs,'symbol','Emblem',{options:['✦','◆','✿','▲']});
  field(inputs,'capabilities','Capabilities or interests',{type:'textarea',max:300,required:false,full:true});
  field(inputs,'limitations','What should others know about its limits?',{type:'textarea',max:300,required:false,full:true});
}
async function createCharacter(data,node){
  const {calling_id,...profile}=data;
  const result=await api('/agents','POST',profile);
  if(calling_id)await api('/callings/select','POST',{agent_id:result.id,calling_id});
  node.reset();await refresh();await selectAgent(result.id);
  if($('#character-dialog').open)$('#character-dialog').close();
  notice('Your character is ready. Enter the world or create an agent connection.');
}
function renderCharacterOverlay(){
  const node=$('#character-area');if(!node)return;
  node.replaceChildren();
  const pick=card('Pick a resident','WHO IS GOING INTO THE WORLD?');
  if(!state.account){pick.append(paragraph('Sign in to choose or create a character.','privacy'));node.append(pick);return;}
  if(!state.agents.length)pick.append(paragraph('No character yet. Create your first resident below.','privacy'));
  for(const agent of state.agents){
    const row=element('div',null,'record');const top=element('div',null,'agent-row');const bio=element('div');
    append(bio,element('h3',agent.name),badge(agent.kind==='human'?'human player':'AI resident'),badge(agent.status,agent.status!=='active'),paragraph(`${REGIONS.find(region=>region.id===agent.region_id)?.name||'Commons'} · ${agent.world_id||'commons'}`,'privacy'));
    append(top,agentMark(agent),bio);row.append(top);
    const controls=actions();
    const enter=button('Enter the world',()=>{selectAgent(agent.id).then(()=>{$('#character-dialog').close();});},'small');
    enter.disabled=agent.status!=='active';controls.append(enter);
    if(agent.status!=='active')controls.append(button(agent.status==='revoked'?'Resume access':'Resume',()=>change('/agents/control',{agent_id:agent.id,status:'active'},'Character updated.'),'secondary small'));
    row.append(controls);pick.append(row);
  }
  const create=card('Create a resident','A NEW ARRIVAL');
  create.append(paragraph('One human player and up to five AI characters per operator. The server refuses the sixth AI character, a second human player and an unlisted colour.','privacy'));
  const inputs=form(create,'Create character',createCharacter,'character-create');
  characterCreateFields(inputs);
  node.append(pick,create);
}
function openCharacterOverlay(){
  if(!state.account){openAuth('register');return;}
  renderCharacterOverlay();
  $('#character-dialog').showModal();
  $('#character-area input,#character-area button')?.focus?.();
}
