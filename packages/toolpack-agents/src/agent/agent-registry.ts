import { randomUUID } from 'crypto';
import type { AgentInput, AgentOutput, AgentResult, IAgentRegistry, ChannelInterface, AgentInstance, PendingAsk } from './types.js';
import type { BaseAgent } from './base-agent.js';
import type { AgentTransport, AgentRegistryTransportOptions } from '../transport/types.js';
import { LocalTransport } from '../transport/local-transport.js';

/**
 * Optional coordinator for multi-agent deployments.
 *
 * Accepts a list of agent instances (each carrying its own channels and
 * interceptors). On `start()` it wires the registry reference into every agent
 * so cross-agent features (sendTo, delegation, ask) work, then delegates
 * channel lifecycle to each agent's own `start()` method.
 *
 * For a single-agent deployment you do not need this class at all — just call
 * `agent.start()` directly.
 */
export class AgentRegistry implements IAgentRegistry {
  private agentList: BaseAgent[];
  private instances: Map<string, AgentInstance> = new Map();
  private channels: Map<string, ChannelInterface> = new Map();

  /** Transport for agent-to-agent communication */
  _transport: AgentTransport;

  /** In-memory store for pending human-in-the-loop questions. Stored as Map<conversationId, PendingAsk[]> */
  private pendingAsks: Map<string, PendingAsk[]> = new Map();

  private _started = false;
  private _restarting = false;
  private _restartScheduled = false;
  private _deadlineTimer?: ReturnType<typeof setTimeout>;

  /**
   * @param agents Agent instances to coordinate. Each agent's `channels` and
   *   `interceptors` are configured on the agent itself.
   * @param options Optional transport override.
   */
  constructor(agents: BaseAgent[], options?: AgentRegistryTransportOptions) {
    this.agentList = agents;
    this._transport = options?.transport || new LocalTransport(this);
  }

  /**
   * Start all agents.
   *
   * For each agent:
   * 1. Ensures the agent's Toolpack instance is ready.
   * 2. Sets `agent._registry = this` so cross-agent features are available
   *    when the agent's channels start processing messages.
   * 3. Registers named channels in the registry's routing table for `sendTo()`.
   * 4. Calls `agent.start()` which binds message handlers and begins listening.
   */
  async start(): Promise<void> {
    for (const agent of this.agentList) {
      // Initialise toolpack before setting registry so it is ready when the
      // first message arrives.
      await agent._ensureToolpack();

      // Wire registry so sendTo(), ask(), and delegate() work inside the agent.
      agent._registry = this;

      this.instances.set(agent.name, agent);

      // Register named channels for sendTo() routing.
      for (const channel of agent.channels ?? []) {
        if (channel.name) {
          this.channels.set(channel.name, channel);
        }
      }
    }

    // Start all agents (binds message handlers + begins listening).
    for (const agent of this.agentList) {
      await agent.start();
    }

    this._started = true;
  }

  /**
   * Add an agent to the registry. If the registry is already started the agent
   * is fully wired and started immediately; otherwise it is deferred until start().
   */
  async addAgent(agent: BaseAgent): Promise<void> {
    this.agentList.push(agent);

    if (!this._started) return;

    await agent._ensureToolpack();
    agent._registry = this;
    this.instances.set(agent.name, agent);

    for (const channel of agent.channels ?? []) {
      if (channel.name) {
        this.channels.set(channel.name, channel);
      }
    }

    await agent.start();
  }

  /**
   * Remove an agent by name. Stops the agent and unregisters its channels.
   * No-op when the name is not found.
   */
  async removeAgent(name: string): Promise<void> {
    const agent = this.instances.get(name) as BaseAgent | undefined;
    if (!agent) return;

    await agent.stop();

    this.instances.delete(name);
    this.agentList = this.agentList.filter(a => a.name !== name);

    for (const channel of agent.channels ?? []) {
      if (channel.name) {
        this.channels.delete(channel.name);
      }
    }
  }

  /** Returns true when all registered agents have no in-progress conversations. */
  isAllIdle(): boolean {
    return this.agentList.every(agent => agent.isIdle());
  }

  /**
   * Schedule a graceful restart once all agents are idle, or force one after
   * maxWaitMinutes (default 30). Idempotent — subsequent calls are ignored.
   *
   * Uses process.exit(0) so a process manager (PM2, systemd) can restart with
   * the updated dist/ and .env. Override _exit() in tests to prevent that.
   */
  scheduleRestart(options?: { maxWaitMinutes?: number }): void {
    if (this._restartScheduled) return;
    this._restartScheduled = true;

    const maxWaitMs = (options?.maxWaitMinutes ?? 30) * 60 * 1000;

    const tryRestart = () => {
      if (!this._restarting && this.isAllIdle()) {
        void this._executeRestart();
      }
    };

    tryRestart();
    if (this._restarting) return;

    for (const agent of this.agentList) {
      agent.on('agent:complete', tryRestart);
    }

    this._deadlineTimer = setTimeout(() => {
      void this._executeRestart();
    }, maxWaitMs);
  }

  async _executeRestart(): Promise<void> {
    if (this._restarting) return;
    this._restarting = true;

    if (this._deadlineTimer) {
      clearTimeout(this._deadlineTimer);
      this._deadlineTimer = undefined;
    }

    await this.stop();

    const drainDeadline = Date.now() + 30_000;
    while (!this.isAllIdle() && Date.now() < drainDeadline) {
      await new Promise<void>(r => setTimeout(r, 100));
    }

    this._exit(0);
  }

  protected _exit(code: number): void {
    process.exit(code);
  }

  /**
   * Send output to a named channel.
   */
  async sendTo(channelName: string, output: AgentOutput): Promise<void> {
    const channel = this.channels.get(channelName);
    if (!channel) {
      throw new Error(`No channel registered with name "${channelName}"`);
    }
    await channel.send(output);
  }

  /**
   * Get a registered agent instance by name.
   */
  getAgent(name: string): AgentInstance | undefined {
    return this.instances.get(name);
  }

  /**
   * Get all registered agent instances.
   */
  getAllAgents(): AgentInstance[] {
    return Array.from(this.instances.values());
  }

  /**
   * Get a registered channel by name.
   */
  getChannel(name: string): ChannelInterface | undefined {
    return this.channels.get(name);
  }

  /**
   * Invoke an agent by name through the transport layer.
   * Used by BaseAgent.delegate() and BaseAgent.delegateAndWait().
   */
  async invoke(agentName: string, input: AgentInput): Promise<AgentResult> {
    return this._transport.invoke(agentName, input);
  }

  /**
   * Stop all agents and clean up resources.
   */
  async stop(): Promise<void> {
    for (const agent of this.agentList) {
      await agent.stop();
    }

    this.instances.clear();
    this.channels.clear();
    this.pendingAsks.clear();
  }

  // --- PendingAsksStore Methods ---

  getPendingAsk(conversationId: string): PendingAsk | undefined {
    const asks = this.pendingAsks.get(conversationId);
    if (!asks || asks.length === 0) {
      return undefined;
    }

    const now = new Date();
    while (asks.length > 0) {
      const front = asks[0];
      if (front.expiresAt && front.expiresAt < now) {
        asks.shift();
      } else {
        break;
      }
    }

    if (asks.length === 0) {
      this.pendingAsks.delete(conversationId);
      return undefined;
    }

    return asks[0];
  }

  hasPendingAsks(conversationId: string): boolean {
    const asks = this.pendingAsks.get(conversationId);
    if (!asks || asks.length === 0) {
      return false;
    }

    const now = new Date();
    const validAsks = asks.filter(a => !a.expiresAt || a.expiresAt >= now);

    if (validAsks.length === 0) {
      this.pendingAsks.delete(conversationId);
      return false;
    }

    if (validAsks.length !== asks.length) {
      this.pendingAsks.set(conversationId, validAsks);
    }

    return validAsks.some(a => a.status === 'pending');
  }

  cleanupExpiredAsks(): number {
    let removedCount = 0;
    const now = new Date();

    for (const [conversationId, asks] of this.pendingAsks.entries()) {
      const validAsks = asks.filter(a => !a.expiresAt || a.expiresAt >= now);
      removedCount += asks.length - validAsks.length;

      if (validAsks.length === 0) {
        this.pendingAsks.delete(conversationId);
      } else if (validAsks.length !== asks.length) {
        this.pendingAsks.set(conversationId, validAsks);
      }
    }

    return removedCount;
  }

  addPendingAsk(
    ask: Omit<PendingAsk, 'id' | 'askedAt' | 'retries' | 'status'>
  ): PendingAsk {
    const pendingAsk: PendingAsk = {
      ...ask,
      id: randomUUID(),
      askedAt: new Date(),
      retries: 0,
      status: 'pending',
    };

    const existing = this.pendingAsks.get(ask.conversationId);
    if (existing) {
      existing.push(pendingAsk);
    } else {
      this.pendingAsks.set(ask.conversationId, [pendingAsk]);
    }

    return pendingAsk;
  }

  incrementRetries(id: string): number | undefined {
    for (const asks of this.pendingAsks.values()) {
      const ask = asks.find(a => a.id === id);
      if (ask) {
        ask.retries += 1;
        return ask.retries;
      }
    }
    return undefined;
  }

  async resolvePendingAsk(id: string, answer: string): Promise<void> {
    for (const [conversationId, asks] of this.pendingAsks.entries()) {
      const index = asks.findIndex(a => a.id === id);
      if (index !== -1) {
        asks[index].status = 'answered';
        asks[index].answer = answer;

        const channelName = asks[index].channelName;

        asks.splice(index, 1);

        if (asks.length > 0) {
          const nextAsk = asks[0];
          if (channelName && channelName.trim() !== '') {
            try {
              await this.sendTo(channelName, { output: nextAsk.question });
            } catch (error) {
              console.error(`[AgentRegistry] Failed to auto-send next ask: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
          } else {
            console.warn(`[AgentRegistry] Cannot auto-send next ask: channelName is empty for conversation ${conversationId}`);
          }
        }

        if (asks.length === 0) {
          this.pendingAsks.delete(conversationId);
        }
        return;
      }
    }

    throw new Error(`Pending ask with id "${id}" not found`);
  }
}
