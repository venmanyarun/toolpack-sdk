import { describe, it, expect, vi, afterEach } from 'vitest';
import { AgentRegistry } from './agent-registry.js';
import { BaseAgent } from './base-agent.js';
import { AgentInput, AgentResult, BaseAgentOptions } from './types.js';
import { BaseChannel } from '../channels/base-channel.js';
import type { Toolpack } from 'toolpack-sdk';
import { CHAT_MODE } from 'toolpack-sdk';

// Mock Toolpack
const createMockToolpack = () => {
  return {
    generate: vi.fn().mockResolvedValue({
      content: 'Mock response',
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }),
    setMode: vi.fn(),
    registerMode: vi.fn(),
  } as unknown as Toolpack;
};

// Test agent implementation
class TestAgent extends BaseAgent<'test_intent'> {
  name = 'test-agent';
  description = 'A test agent';
  mode = CHAT_MODE;

  constructor(options: BaseAgentOptions) {
    super(options);
  }

  async invokeAgent(input: AgentInput<'test_intent'>): Promise<AgentResult> {
    return {
      output: `Received: ${input.message}`,
    };
  }
}

// Test channel implementation
class TestChannel extends BaseChannel {
  readonly isTriggerChannel = false;
  handler?: (input: AgentInput) => Promise<void>;
  sent: { output: string; metadata?: Record<string, unknown> }[] = [];

  listen(): void {}

  async send(output: { output: string; metadata?: Record<string, unknown> }): Promise<void> {
    this.sent.push(output as { output: string; metadata?: Record<string, unknown> });
  }

  normalize(incoming: unknown): AgentInput {
    return { message: String(incoming) };
  }

  onMessage(handler: (input: AgentInput) => Promise<void>): void {
    this.handler = handler;
  }

  async triggerMessage(input: AgentInput): Promise<void> {
    if (this.handler) {
      await this.handler(input);
    }
  }
}

describe('AgentRegistry', () => {
  describe('constructor', () => {
    it('should create with empty agents list', () => {
      const registry = new AgentRegistry([]);
      expect(registry).toBeDefined();
    });

    it('should create with agent instances', () => {
      const mockToolpack = createMockToolpack();
      const channel = new TestChannel();
      const agent = new TestAgent({ toolpack: mockToolpack });
      agent.channels = [channel];

      const registry = new AgentRegistry([agent]);
      expect(registry).toBeDefined();
    });
  });

  describe('start', () => {
    it('should bind message handlers and start channels', async () => {
      const mockToolpack = createMockToolpack();
      const channel = new TestChannel();
      const spyListen = vi.spyOn(channel, 'listen');

      const agent = new TestAgent({ toolpack: mockToolpack });
      agent.channels = [channel];

      const registry = new AgentRegistry([agent]);
      await registry.start();

      expect(spyListen).toHaveBeenCalled();
      expect(channel.handler).toBeDefined();
    });

    it('should set agent registry reference', async () => {
      const mockToolpack = createMockToolpack();
      const channel = new TestChannel();

      const agent = new TestAgent({ toolpack: mockToolpack });
      agent.channels = [channel];

      const registry = new AgentRegistry([agent]);
      await registry.start();

      const retrieved = registry.getAgent('test-agent');
      expect(retrieved).toBeDefined();
      expect(retrieved?._registry).toBe(registry);
    });

    it('should register named channels for sendTo() routing', async () => {
      const mockToolpack = createMockToolpack();
      const channel = new TestChannel();
      channel.name = 'test-channel';

      const agent = new TestAgent({ toolpack: mockToolpack });
      agent.channels = [channel];

      const registry = new AgentRegistry([agent]);
      await registry.start();

      const retrievedChannel = registry.getChannel('test-channel');
      expect(retrievedChannel).toBe(channel);
    });
  });

  describe('sendTo', () => {
    it('should send to named channel', async () => {
      const mockToolpack = createMockToolpack();
      const channel = new TestChannel();
      channel.name = 'my-channel';

      const agent = new TestAgent({ toolpack: mockToolpack });
      agent.channels = [channel];

      const registry = new AgentRegistry([agent]);
      await registry.start();

      await registry.sendTo('my-channel', { output: 'Hello!' });

      expect(channel.sent).toHaveLength(1);
      expect(channel.sent[0]).toEqual({ output: 'Hello!' });
    });

    it('should throw for unknown channel', async () => {
      const registry = new AgentRegistry([]);
      await registry.start();

      await expect(registry.sendTo('unknown', { output: 'test' }))
        .rejects.toThrow('No channel registered with name "unknown"');
    });
  });

  describe('getAgent', () => {
    it('should return agent by name', async () => {
      const mockToolpack = createMockToolpack();
      const agent = new TestAgent({ toolpack: mockToolpack });

      const registry = new AgentRegistry([agent]);
      await registry.start();

      const retrieved = registry.getAgent('test-agent');
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe('test-agent');
    });

    it('should return undefined for unknown agent', async () => {
      const mockToolpack = createMockToolpack();
      const agent = new TestAgent({ toolpack: mockToolpack });

      const registry = new AgentRegistry([agent]);
      await registry.start();

      expect(registry.getAgent('unknown')).toBeUndefined();
    });
  });

  describe('getAllAgents', () => {
    it('should return all agents', async () => {
      const mockToolpack = createMockToolpack();

      class TestAgent2 extends BaseAgent {
        name = 'test-agent-2';
        description = 'Another test agent';
        mode = CHAT_MODE;

        constructor(options: BaseAgentOptions) {
          super(options);
        }

        async invokeAgent(): Promise<AgentResult> {
          return { output: 'Test 2' };
        }
      }

      const agent1 = new TestAgent({ toolpack: mockToolpack });
      const agent2 = new TestAgent2({ toolpack: mockToolpack });

      const registry = new AgentRegistry([agent1, agent2]);
      await registry.start();

      const agents = registry.getAllAgents();
      expect(agents).toHaveLength(2);
      expect(agents.map(a => a.name)).toContain('test-agent');
      expect(agents.map(a => a.name)).toContain('test-agent-2');
    });
  });

  describe('stop', () => {
    it('should clear agents and channels', async () => {
      const mockToolpack = createMockToolpack();
      const agent = new TestAgent({ toolpack: mockToolpack });

      const registry = new AgentRegistry([agent]);
      await registry.start();

      expect(registry.getAgent('test-agent')).toBeDefined();

      await registry.stop();

      expect(registry.getAgent('test-agent')).toBeUndefined();
    });

    it('should stop channels with stop method', async () => {
      const mockToolpack = createMockToolpack();

      class StoppableChannel extends TestChannel {
        stopped = false;
        async stop(): Promise<void> {
          this.stopped = true;
        }
      }

      const channel = new StoppableChannel();
      channel.name = 'stoppable';

      const agent = new TestAgent({ toolpack: mockToolpack });
      agent.channels = [channel];

      const registry = new AgentRegistry([agent]);
      await registry.start();
      await registry.stop();

      expect(channel.stopped).toBe(true);
    });
  });

  describe('PendingAsksStore', () => {
    describe('addPendingAsk', () => {
      it('should add a pending ask', () => {
        const registry = new AgentRegistry([]);
        const ask = registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'What is your name?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        expect(ask.id).toBeDefined();
        expect(ask.conversationId).toBe('test-conv');
        expect(ask.question).toBe('What is your name?');
        expect(ask.status).toBe('pending');
        expect(ask.retries).toBe(0);
        expect(ask.askedAt).toBeInstanceOf(Date);
      });

      it('should queue multiple asks for same conversation', () => {
        const registry = new AgentRegistry([]);

        const ask1 = registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'First question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        const ask2 = registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'Second question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        expect(ask1.id).not.toBe(ask2.id);
      });
    });

    describe('getPendingAsk', () => {
      it('should return the first pending ask', () => {
        const registry = new AgentRegistry([]);
        registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'First question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        const pending = registry.getPendingAsk('test-conv');
        expect(pending?.question).toBe('First question?');
      });

      it('should return undefined if no pending asks', () => {
        const registry = new AgentRegistry([]);
        const pending = registry.getPendingAsk('test-conv');
        expect(pending).toBeUndefined();
      });
    });

    describe('hasPendingAsks', () => {
      it('should return true if has pending asks', () => {
        const registry = new AgentRegistry([]);
        registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'Question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        expect(registry.hasPendingAsks('test-conv')).toBe(true);
      });

      it('should return false if no pending asks', () => {
        const registry = new AgentRegistry([]);
        expect(registry.hasPendingAsks('test-conv')).toBe(false);
      });
    });

    describe('resolvePendingAsk', () => {
      it('should resolve the ask', async () => {
        const registry = new AgentRegistry([]);
        const ask = registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'Question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        await registry.resolvePendingAsk(ask.id, 'Answer');

        expect(registry.getPendingAsk('test-conv')).toBeUndefined();
      });

      it('should auto-send next ask when resolving', async () => {
        const registry = new AgentRegistry([]);
        const ask1 = registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'First question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'Second question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        expect(registry.getPendingAsk('test-conv')?.question).toBe('First question?');

        const sendToMock = vi.fn().mockResolvedValue(undefined);
        registry.sendTo = sendToMock;

        await registry.resolvePendingAsk(ask1.id, 'Answer 1');

        expect(sendToMock).toHaveBeenCalledWith('test-channel', { output: 'Second question?' });
        expect(registry.getPendingAsk('test-conv')?.question).toBe('Second question?');
      });
    });

    describe('incrementRetries', () => {
      it('should increment retry count for a pending ask', () => {
        const registry = new AgentRegistry([]);
        const ask = registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'Question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        expect(ask.retries).toBe(0);

        expect(registry.incrementRetries(ask.id)).toBe(1);
        expect(registry.incrementRetries(ask.id)).toBe(2);
      });

      it('should return undefined for non-existent ask', () => {
        const registry = new AgentRegistry([]);
        expect(registry.incrementRetries('non-existent-id')).toBeUndefined();
      });
    });

    describe('stop clears pending asks', () => {
      it('should clear pending asks on stop', async () => {
        const registry = new AgentRegistry([]);

        registry.addPendingAsk({
          conversationId: 'test-conv',
          agentName: 'test-agent',
          question: 'Question?',
          context: {},
          maxRetries: 2,
          channelName: 'test-channel',
        });

        expect(registry.hasPendingAsks('test-conv')).toBe(true);

        await registry.stop();

        expect(registry.hasPendingAsks('test-conv')).toBe(false);
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Testable subclass that intercepts process.exit so tests don't die.
  // ---------------------------------------------------------------------------
  class TestableRegistry extends AgentRegistry {
    readonly exitCalls: number[] = [];
    protected override _exit(code: number): void {
      this.exitCalls.push(code);
    }
  }

  describe('addAgent', () => {
    it('adds an agent before start — deferred wiring', async () => {
      const mockToolpack = createMockToolpack();
      const registry = new AgentRegistry([]);
      const agent = new TestAgent({ toolpack: mockToolpack });

      await registry.addAgent(agent);
      // Not started yet — instances map is still empty
      expect(registry.getAgent('test-agent')).toBeUndefined();

      await registry.start();
      expect(registry.getAgent('test-agent')).toBeDefined();
    });

    it('adds and starts agent on an already-started registry', async () => {
      const mockToolpack = createMockToolpack();
      const registry = new AgentRegistry([]);
      await registry.start();

      const agent = new TestAgent({ toolpack: mockToolpack });
      const channel = new TestChannel();
      channel.name = 'dynamic-channel';
      agent.channels = [channel];

      await registry.addAgent(agent);

      expect(registry.getAgent('test-agent')).toBeDefined();
      expect(registry.getChannel('dynamic-channel')).toBeDefined();
    });
  });

  describe('removeAgent', () => {
    it('removes agent and its named channels', async () => {
      const mockToolpack = createMockToolpack();
      const channel = new TestChannel();
      channel.name = 'removable-channel';
      const agent = new TestAgent({ toolpack: mockToolpack });
      agent.channels = [channel];

      const registry = new AgentRegistry([agent]);
      await registry.start();

      await registry.removeAgent('test-agent');

      expect(registry.getAgent('test-agent')).toBeUndefined();
      expect(registry.getChannel('removable-channel')).toBeUndefined();
    });

    it('is a no-op for an unknown agent name', async () => {
      const registry = new AgentRegistry([]);
      await registry.start();
      await expect(registry.removeAgent('ghost')).resolves.toBeUndefined();
    });
  });

  describe('isAllIdle', () => {
    it('returns true when the registry has no agents', () => {
      const registry = new AgentRegistry([]);
      expect(registry.isAllIdle()).toBe(true);
    });

    it('returns true when all agents have no in-flight conversations', async () => {
      const mockToolpack = createMockToolpack();
      const agent = new TestAgent({ toolpack: mockToolpack });
      const registry = new AgentRegistry([agent]);
      await registry.start();

      expect(registry.isAllIdle()).toBe(true);
    });
  });

  describe('scheduleRestart', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('calls _exit(0) immediately when all agents are already idle', async () => {
      vi.useFakeTimers();
      const registry = new TestableRegistry([]);
      await registry.start();

      registry.scheduleRestart();
      await vi.runAllTimersAsync();

      expect(registry.exitCalls).toEqual([0]);
    });

    it('calls _exit(0) after agent:complete when not initially idle', async () => {
      vi.useFakeTimers();
      const mockToolpack = createMockToolpack();
      const agent = new TestAgent({ toolpack: mockToolpack });
      const registry = new TestableRegistry([agent]);
      await registry.start();

      vi.spyOn(registry, 'isAllIdle')
        .mockReturnValueOnce(false)
        .mockReturnValue(true);

      registry.scheduleRestart();
      expect(registry.exitCalls).toHaveLength(0);

      agent.emit('agent:complete', { output: 'done' });
      await vi.runAllTimersAsync();

      expect(registry.exitCalls).toEqual([0]);
    });

    it('forces _exit(0) after the deadline even when agents stay busy', async () => {
      vi.useFakeTimers();
      const registry = new TestableRegistry([]);
      await registry.start();

      vi.spyOn(registry, 'isAllIdle')
        .mockReturnValueOnce(false)
        .mockReturnValue(true);

      registry.scheduleRestart({ maxWaitMinutes: 30 });

      await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 1);
      await vi.runAllTimersAsync();

      expect(registry.exitCalls).toEqual([0]);
    });

    it('is idempotent — second scheduleRestart call is ignored', async () => {
      vi.useFakeTimers();
      const registry = new TestableRegistry([]);
      await registry.start();

      registry.scheduleRestart();
      registry.scheduleRestart();
      await vi.runAllTimersAsync();

      expect(registry.exitCalls).toHaveLength(1);
    });
  });

  describe('_executeRestart', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('_restarting guard prevents double _exit', async () => {
      vi.useFakeTimers();
      const registry = new TestableRegistry([]);
      await registry.start();

      void registry._executeRestart();
      void registry._executeRestart();
      await vi.runAllTimersAsync();

      expect(registry.exitCalls).toHaveLength(1);
    });

    it('stops all channels before calling _exit', async () => {
      vi.useFakeTimers();
      const mockToolpack = createMockToolpack();

      class StoppableChannel extends TestChannel {
        stopped = false;
        override async stop(): Promise<void> { this.stopped = true; }
      }

      const channel = new StoppableChannel();
      const agent = new TestAgent({ toolpack: mockToolpack });
      agent.channels = [channel];

      const registry = new TestableRegistry([agent]);
      await registry.start();

      await registry._executeRestart();

      expect(channel.stopped).toBe(true);
      expect(registry.exitCalls).toEqual([0]);
    });

    it('exits even when drain loop reaches its deadline', async () => {
      vi.useFakeTimers();
      const registry = new TestableRegistry([]);
      await registry.start();

      // Simulate agents always busy — loop must exhaust its 30 s timeout.
      vi.spyOn(registry, 'isAllIdle').mockReturnValue(false);

      const restartPromise = registry._executeRestart();
      // Advance through the 30 s drain loop (300 × 100 ms iterations).
      await vi.advanceTimersByTimeAsync(31_000);
      await restartPromise;

      expect(registry.exitCalls).toEqual([0]);
    });
  });
});
