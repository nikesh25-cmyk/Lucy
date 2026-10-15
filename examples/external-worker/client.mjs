#!/usr/bin/env node
// NemoWorld External AI Worker Reference Client.
// Demonstrates how a separately hosted external worker connects to NemoWorld
// using the existing scoped runtime API.
//
// Guarantees:
// 1. Credentials read strictly from process.env.NEMOWORLD_RUNTIME_TOKEN.
// 2. The token is never printed, logged, or saved to disk.
// 3. Rate-limiting (HTTP 429) triggers exponential backoff.
// 4. Revocation (HTTP 401/403) triggers a clean shutdown.
// 5. Authoritative State Reconciliation: Before dispatching actions and upon
//    recovery from an unexpected exit or network drop, the client inspects
//    in-flight action intents against authoritative server state to avoid
//    unintended re-execution of non-idempotent endpoints (e.g. /move).
// 6. Idempotent route support: Supplies Idempotency-Key headers for routes
//    supporting server-side deduplication.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export function computeExpectedTarget(origin, direction) {
  const target = { x: origin.x, y: origin.y, world_id: origin.world_id };
  if (direction === 'right') target.x += 1;
  else if (direction === 'left') target.x -= 1;
  else if (direction === 'down') target.y += 1;
  else if (direction === 'up') target.y -= 1;
  return target;
}

export class ExternalWorkerClient {
  constructor(options = {}) {
    this.apiUrl = (options.apiUrl || process.env.NEMOWORLD_API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    this.token = options.token || process.env.NEMOWORLD_RUNTIME_TOKEN;
    if (!this.token) {
      throw new Error('NEMOWORLD_RUNTIME_TOKEN environment variable is required.');
    }
    this.stateFile = options.stateFile || process.env.NEMOWORLD_STATE_FILE || join(process.cwd(), '.worker-state.json');
    this.onBeforeSaveCompletion = options.onBeforeSaveCompletion || null;
    this.agentId = options.agentId || null;
    this.state = this._loadState();
  }

  _loadState() {
    if (existsSync(this.stateFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.stateFile, 'utf8'));
        return {
          completedActions: Array.isArray(parsed.completedActions) ? parsed.completedActions : [],
          inFlight: parsed.inFlight || null,
          uncertainDiverged: Array.isArray(parsed.uncertainDiverged) ? parsed.uncertainDiverged : [],
        };
      } catch {
        return { completedActions: [], inFlight: null, uncertainDiverged: [] };
      }
    }
    return { completedActions: [], inFlight: null, uncertainDiverged: [] };
  }

  _saveState() {
    writeFileSync(this.stateFile, JSON.stringify(this.state, null, 2), 'utf8');
  }

  async _request(path, method = 'GET', body = null, extraHeaders = {}) {
    const url = `${this.apiUrl}/api/v1${path}`;
    const headers = {
      'Authorization': `Bearer ${this.token}`,
      'Accept': 'application/json',
      ...extraHeaders,
    };
    if (body) headers['Content-Type'] = 'application/json';

    let backoffMs = 200;
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const res = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });

      if (res.status === 429) {
        if (attempt === maxRetries) {
          throw new Error('Rate limit exceeded (HTTP 429); action budget or request threshold exhausted.');
        }
        await new Promise((r) => setTimeout(r, backoffMs));
        backoffMs *= 2;
        continue;
      }

      if (res.status === 401 || res.status === 403) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(`Authentication/Scope refusal (HTTP ${res.status}): ${errorData.error || 'Refused'}`);
      }

      if (!res.ok) {
        const errorData = await res.json().catch(() => ({}));
        throw new Error(`Request failed (HTTP ${res.status}): ${errorData.error || res.statusText}`);
      }

      return res.json();
    }
  }

  async getStatus() {
    const status = await this._request('/runtime/status');
    if (status.agent_id && !this.agentId) {
      this.agentId = status.agent_id;
    }
    return status;
  }

  async observeWorld(worldId = null) {
    const query = worldId ? `?world_id=${encodeURIComponent(worldId)}` : '';
    return this._request(`/world${query}`);
  }

  async getAgentPosition() {
    if (!this.agentId) {
      await this.getStatus();
    }
    const worldData = await this.observeWorld();
    const participants = worldData.participants || [];
    const me = participants.find((p) => p.id === this.agentId);
    if (!me) {
      throw new Error(`Agent ${this.agentId} not found in visible world participants.`);
    }
    return {
      x: me.x,
      y: me.y,
      z: me.z ?? 0,
      world_id: worldData.world?.id || 'commons',
    };
  }

  /**
   * Authoritative State Reconciliation
   * Reconciles any in-flight intent recorded prior to a process crash or disconnect.
   */
  async reconcileInFlight() {
    if (!this.state.inFlight) {
      return { reconciled: false, inFlight: null };
    }

    const inFlight = this.state.inFlight;
    const current = await this.getAgentPosition();
    const target = inFlight.expectedTarget;
    const origin = inFlight.origin;

    if (current.x === target.x && current.y === target.y && current.world_id === target.world_id) {
      // The server successfully committed the move before the client crashed!
      if (!this.state.completedActions.includes(inFlight.actionId)) {
        this.state.completedActions.push(inFlight.actionId);
      }
      this.state.inFlight = null;
      this._saveState();
      return {
        reconciled: true,
        actionId: inFlight.actionId,
        outcome: 'already_committed',
        position: current,
      };
    } else if (current.x === origin.x && current.y === origin.y && current.world_id === origin.world_id) {
      // The move was NOT committed by the server (e.g. process died before dispatch).
      this.state.inFlight = null;
      this._saveState();
      return {
        reconciled: true,
        actionId: inFlight.actionId,
        outcome: 'not_committed',
        position: current,
      };
    } else {
      // Coordinates diverged from both origin and target.
      // Classify as uncertain diverged and require manual/operator inspection.
      this.state.uncertainDiverged.push({
        ...inFlight,
        divergedAt: Date.now(),
        observedPosition: current,
      });
      this.state.inFlight = null;
      this._saveState();
      return {
        reconciled: true,
        actionId: inFlight.actionId,
        outcome: 'diverged',
        position: current,
      };
    }
  }

  async performPermittedMove(direction = 'right', actionId = null) {
    const currentActionId = actionId || `move-${Date.now()}`;

    // 1. Reconcile any prior interrupted action first
    const reconciliation = await this.reconcileInFlight();
    if (reconciliation.reconciled && reconciliation.actionId === currentActionId && reconciliation.outcome === 'already_committed') {
      return {
        skipped: true,
        reason: 'Action was committed by authoritative server prior to restart and reconciled safely.',
        reconciled: true,
        outcome: reconciliation.outcome,
      };
    }

    // 2. Check if already marked completed
    if (this.state.completedActions.includes(currentActionId)) {
      return {
        skipped: true,
        reason: 'Action already completed according to reconciled state store.',
        reconciled: false,
      };
    }

    // 3. Inspect current authoritative position and determine target coordinates
    const currentPos = await this.getAgentPosition();
    const expectedTarget = computeExpectedTarget(currentPos, direction);

    // 4. Record Intent in persistent store BEFORE dispatching
    this.state.inFlight = {
      actionId: currentActionId,
      type: 'move',
      direction,
      origin: currentPos,
      expectedTarget,
      dispatchedAt: Date.now(),
      status: 'in_flight',
    };
    this._saveState();

    // 5. Dispatch non-idempotent move to server
    const result = await this._request('/move', 'POST', {
      direction,
    });

    // 6. Failure injection hook: simulate process kill before completion persist
    if (typeof this.onBeforeSaveCompletion === 'function') {
      await this.onBeforeSaveCompletion({
        actionId: currentActionId,
        result,
        expectedTarget,
      });
    }

    // 7. Mark completion and clear inFlight
    this.state.completedActions.push(currentActionId);
    this.state.inFlight = null;
    this._saveState();

    return { skipped: false, result, expectedTarget };
  }

  /**
   * Demonstrates performing an action on an endpoint that natively supports
   * Idempotency-Key headers on the server.
   */
  async performIdempotentAction(route, payload, actionId) {
    if (this.state.completedActions.includes(actionId)) {
      return { skipped: true, reason: 'Action already completed' };
    }

    const result = await this._request(route, 'POST', payload, {
      'Idempotency-Key': actionId,
    });

    this.state.completedActions.push(actionId);
    this._saveState();
    return { skipped: false, result };
  }
}

if (process.argv[1] && process.argv[1].endsWith('client.mjs')) {
  async function run() {
    console.log('NemoWorld External AI Worker Reference Client');
    try {
      const client = new ExternalWorkerClient();
      const status = await client.getStatus();
      console.log(`Connected successfully. Assigned Resident ID: ${status.agent_id}`);
      console.log(`Remaining Budget Calls: ${status.remaining_calls}`);
      console.log(`Granted Scopes: ${(status.scopes || []).join(', ')}`);

      console.log('\nReconciling any in-flight actions from prior executions...');
      const recon = await client.reconcileInFlight();
      if (recon.reconciled) {
        console.log(`Reconciled in-flight action: ${recon.actionId} -> outcome: ${recon.outcome}`);
      } else {
        console.log('No unconfirmed actions in flight.');
      }

      console.log('\nExecuting one permitted action with pre-action intent logging...');
      const actionResult = await client.performPermittedMove('right', 'patrol-step-1');
      console.log('Action result:', actionResult);
    } catch (err) {
      console.error(`Worker error: ${err.message}`);
      process.exit(1);
    }
  }
  run();
}
