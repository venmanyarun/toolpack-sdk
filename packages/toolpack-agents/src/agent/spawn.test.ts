import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BaseAgent } from './base-agent.js';
import { EphemeralAgent } from './ephemeral-agent.js';
import type { AgentInput, AgentResult, BaseAgentOptions, AgentSpawnConfig } from './types.js';
import type { RequestToolDefinition, Toolpack, ModeConfig } from 'toolpack-sdk';
import { CHAT_MODE } from 'toolpack-sdk';

// ---- helpers ----------------------------------------------------------------

const createMockToolpack = (): Toolpack =>
  ({
    generate: vi.fn().mockResolvedValue({ content: 'default mock response' }),
    setMode: vi.fn(),
    registerMode: vi.fn(),
  }) as unknown as Toolpack;

const TEST_MODE: ModeConfig = {
  ...CHAT_MODE,
  name: 'orchestrator-mode',
  systemPrompt: 'You are an orchestrating agent.',
};

const BASIC_SPAWN_CONFIG: AgentSpawnConfig = {
  enabled: true,
  templates: [
    {
      name: 'researcher',
      description: 'Searches and summarises information',
      systemPrompt: (task) => `You are a research assistant. Task: ${task}`,
    },
    {
      name: 'writer',
      description: 'Writes polished prose from notes',
      systemPrompt: (task) => `You are a writing assistant. Task: ${task}`,
      model: 'claude-haiku-4-5-20251001',
    },
  ],
};

/** Minimal concrete agent that exposes run() for testing. */
class OrchestratorAgent extends BaseAgent {
  name = 'orchestrator';
  description = 'Orchestrates sub-tasks';
  mode = TEST_MODE;

  constructor(options: BaseAgentOptions, spawnCfg?: AgentSpawnConfig) {
    super(options);
    if (spawnCfg) this.spawn = spawnCfg;
  }

  async invokeAgent(input: AgentInput): Promise<AgentResult> {
    return this.run(input.message ?? '', undefined, {
      conversationId: input.conversationId,
      spawnDepth: (input.context?.spawnDepth as number | undefined) ?? 0,
    });
  }
}

/**
 * Builds a generate mock that, on the first call, simulates the LLM invoking
 * `spawn_agent` with the given args and returns `content` as the final reply.
 * On subsequent calls (from the spawned agent) it returns `spawnedContent`.
 */
function buildSpawnSimulatingMock(
  spawnArgs: Record<string, unknown>,
  spawnedContent = 'spawned result',
  orchestratorContent = (spawnOut: string) => `orchestrated: ${spawnOut}`,
) {
  let depth = 0;
  return vi.fn().mockImplementation(async (req: { requestTools?: RequestToolDefinition[] }) => {
    depth++;
    if (depth === 1) {
      // Orchestrator call — simulate LLM calling spawn_agent
      const tool = req.requestTools?.find(t => t.name === 'spawn_agent');
      if (!tool) throw new Error('spawn_agent tool not injected');
      const spawnResult = await tool.execute(spawnArgs);
      return { content: orchestratorContent(spawnResult.output as string) };
    }
    // Spawned agent call
    return { content: spawnedContent };
  });
}

// ---- tests ------------------------------------------------------------------

describe('AgentSpawnConfig — spawn_agent tool injection', () => {
  let mockToolpack: Toolpack;

  beforeEach(() => {
    mockToolpack = createMockToolpack();
  });

  // --------------------------------------------------------------------------
  it('spawns a template agent and returns its result to the orchestrator', async () => {
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      buildSpawnSimulatingMock(
        { template: 'researcher', task: 'latest AI trends' },
        'AI is advancing rapidly',
        (out) => `Summary: ${out}`,
      ),
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, BASIC_SPAWN_CONFIG);
    const result = await agent.invokeAgent({ message: 'Research AI trends', conversationId: 'c1' });

    expect(result.output).toBe('Summary: AI is advancing rapidly');
    // generate was called twice: once for orchestrator, once for spawned agent
    expect(mockToolpack.generate).toHaveBeenCalledTimes(2);
  });

  // --------------------------------------------------------------------------
  it('spawn_agent tool not injected when spawn.enabled = false', async () => {
    let capturedTools: RequestToolDefinition[] | undefined;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        capturedTools = req.requestTools;
        return { content: 'response' };
      },
    );

    const agent = new OrchestratorAgent(
      { toolpack: mockToolpack },
      { enabled: false, templates: BASIC_SPAWN_CONFIG.templates },
    );
    await agent.invokeAgent({ message: 'hello' });

    const spawnTool = capturedTools?.find(t => t.name === 'spawn_agent');
    expect(spawnTool).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  it('spawn_agent tool not injected when spawn is undefined', async () => {
    let capturedTools: RequestToolDefinition[] | undefined;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        capturedTools = req.requestTools;
        return { content: 'response' };
      },
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }); // no spawn config
    await agent.invokeAgent({ message: 'hello' });

    const spawnTool = capturedTools?.find(t => t.name === 'spawn_agent');
    expect(spawnTool).toBeUndefined();
  });

  // --------------------------------------------------------------------------
  it('applies template.model to the spawned agent', async () => {
    const spawnedGenerateCalls: Array<{ model: string }> = [];
    let callCount = 0;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[]; model: string }) => {
        callCount++;
        if (callCount === 1) {
          const tool = req.requestTools?.find(t => t.name === 'spawn_agent');
          await tool!.execute({ template: 'writer', task: 'write a haiku' });
          return { content: 'done' };
        }
        spawnedGenerateCalls.push({ model: req.model });
        return { content: 'haiku written' };
      },
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, BASIC_SPAWN_CONFIG);
    await agent.invokeAgent({ message: 'write something', conversationId: 'c2' });

    expect(spawnedGenerateCalls[0].model).toBe('claude-haiku-4-5-20251001');
  });

  // --------------------------------------------------------------------------
  it('ignores systemPromptAddition and hides the parameter when no template opts in', async () => {
    const spawnedModes: ModeConfig[] = [];
    let callCount = 0;
    let capturedSpawnTool: RequestToolDefinition | undefined;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[]; mode: ModeConfig | string }) => {
        callCount++;
        if (callCount === 1) {
          capturedSpawnTool = req.requestTools?.find(t => t.name === 'spawn_agent');
          await capturedSpawnTool!.execute({
            template: 'researcher',
            task: 'quantum computing',
            systemPromptAddition: 'INJECTED OVERRIDE.',
          });
          return { content: 'done' };
        }
        if (req.mode && typeof req.mode === 'object') spawnedModes.push(req.mode);
        return { content: 'result' };
      },
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, BASIC_SPAWN_CONFIG);
    await agent.invokeAgent({ message: 'research', conversationId: 'c3' });

    const spawnedMode = spawnedModes[0];
    expect(spawnedMode?.systemPrompt).toContain('You are a research assistant.');
    // Addition must be silently dropped — template did not opt in.
    expect(spawnedMode?.systemPrompt).not.toContain('INJECTED OVERRIDE.');
    // Parameter must not appear in the schema so LLM doesn't know it exists.
    const schema = capturedSpawnTool?.parameters as { properties: Record<string, unknown> };
    expect(schema.properties).not.toHaveProperty('systemPromptAddition');
  });

  // --------------------------------------------------------------------------
  it('appends systemPromptAddition only when template sets allowPromptAddition: true', async () => {
    const spawnedModes: ModeConfig[] = [];
    let callCount = 0;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[]; mode: ModeConfig | string }) => {
        callCount++;
        if (callCount === 1) {
          const tool = req.requestTools?.find(t => t.name === 'spawn_agent');
          await tool!.execute({
            template: 'flexible',
            task: 'quantum computing',
            systemPromptAddition: 'Focus only on 2024 papers.',
          });
          return { content: 'done' };
        }
        if (req.mode && typeof req.mode === 'object') spawnedModes.push(req.mode);
        return { content: 'result' };
      },
    );

    const configWithOptIn: AgentSpawnConfig = {
      enabled: true,
      templates: [{
        name: 'flexible',
        description: 'A flexible researcher',
        systemPrompt: (task) => `You are a research assistant. Task: ${task}`,
        allowPromptAddition: true,
      }],
    };
    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, configWithOptIn);
    await agent.invokeAgent({ message: 'research', conversationId: 'c3b' });

    const spawnedMode = spawnedModes[0];
    expect(spawnedMode?.systemPrompt).toContain('You are a research assistant.');
    expect(spawnedMode?.systemPrompt).toContain('Focus only on 2024 papers.');
  });

  // --------------------------------------------------------------------------
  it('depth guard: spawn_agent not injected at maxDepth', async () => {
    const toolsAtEachDepth: Array<string[]> = [];
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        toolsAtEachDepth.push((req.requestTools ?? []).map(t => t.name));
        // Simulate LLM NOT calling spawn — just returns text
        return { content: 'done' };
      },
    );

    const agent = new OrchestratorAgent(
      { toolpack: mockToolpack },
      { enabled: true, templates: BASIC_SPAWN_CONFIG.templates, maxDepth: 1 },
    );

    // Invoke at depth 0 — spawn tool should be present (0 < 1)
    await agent.invokeAgent({
      message: 'do something',
      conversationId: 'c4',
      context: { spawnDepth: 0 },
    });
    expect(toolsAtEachDepth[0]).toContain('spawn_agent');

    // Invoke at maxDepth — spawn tool must be absent (1 >= 1)
    await agent.invokeAgent({
      message: 'do something',
      conversationId: 'c5',
      context: { spawnDepth: 1 },
    });
    expect(toolsAtEachDepth[1]).not.toContain('spawn_agent');
  });

  // --------------------------------------------------------------------------
  it('spawned agent inherits spawn config and can chain-spawn (depth tracking)', async () => {
    const toolCallsByDepth: Array<string[]> = [];
    let callCount = 0;

    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        callCount++;
        const toolNames = (req.requestTools ?? []).map(t => t.name);
        toolCallsByDepth.push(toolNames);

        if (callCount === 1) {
          // depth 0 → spawn once
          const tool = req.requestTools?.find(t => t.name === 'spawn_agent');
          await tool!.execute({ template: 'researcher', task: 'step 1' });
          return { content: 'orchestrated' };
        }
        if (callCount === 2) {
          // depth 1 → spawn again (maxDepth = 3, so still allowed)
          const tool = req.requestTools?.find(t => t.name === 'spawn_agent');
          await tool!.execute({ template: 'writer', task: 'step 2' });
          return { content: 'chained' };
        }
        // depth 2 — just return
        return { content: 'leaf' };
      },
    );

    const agent = new OrchestratorAgent(
      { toolpack: mockToolpack },
      { ...BASIC_SPAWN_CONFIG, maxDepth: 3 },
    );
    await agent.invokeAgent({ message: 'complex task', conversationId: 'c6' });

    expect(callCount).toBe(3); // orchestrator + 2 spawned agents
    expect(toolCallsByDepth[0]).toContain('spawn_agent'); // depth 0 — tool present
    expect(toolCallsByDepth[1]).toContain('spawn_agent'); // depth 1 — still present
    expect(toolCallsByDepth[2]).toContain('spawn_agent'); // depth 2 — present (2 < 3)
  });

  // --------------------------------------------------------------------------
  it('self-replica: spawns a copy of the parent agent, appending the template factory result', async () => {
    let callCount = 0;
    const spawnedModes: ModeConfig[] = [];

    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[]; mode: ModeConfig | string }) => {
        callCount++;
        if (callCount === 1) {
          const tool = req.requestTools?.find(t => t.name === 'spawn_agent');
          await tool!.execute({ template: 'self', task: 'handle the sub-task' });
          return { content: 'done by self-replica' };
        }
        if (req.mode && typeof req.mode === 'object') spawnedModes.push(req.mode);
        return { content: 'replica result' };
      },
    );

    const selfSpawnConfig: AgentSpawnConfig = {
      enabled: true,
      templates: [{
        name: 'self',
        description: 'A replica of this agent',
        systemPrompt: (task) => `Focus on: ${task}`,
      }],
    };
    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, selfSpawnConfig);
    await agent.invokeAgent({ message: 'replicate', conversationId: 'c7' });

    expect(callCount).toBe(2);
    const mode = spawnedModes[0]!;
    // Replica mode name is derived from parent mode with unique suffix
    expect(mode.name).toMatch(/^orchestrator-mode-replica-\d+$/);
    // Parent system prompt is preserved; template factory result is appended
    expect(mode.systemPrompt).toContain('You are an orchestrating agent.');
    expect(mode.systemPrompt).toContain('Focus on: handle the sub-task');
  });

  // --------------------------------------------------------------------------
  it('throws for unknown template name', async () => {
    let capturedTool: RequestToolDefinition | undefined;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        capturedTool = req.requestTools?.find(t => t.name === 'spawn_agent');
        return { content: 'done' };
      },
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, BASIC_SPAWN_CONFIG);
    await agent.invokeAgent({ message: 'hello', conversationId: 'c8' });

    await expect(
      capturedTool!.execute({ template: 'nonexistent', task: 'something' }),
    ).rejects.toThrow('Unknown spawn template: "nonexistent"');
  });

  // --------------------------------------------------------------------------
  it('spawned agent shares parent toolpack instance', async () => {
    let callCount = 0;

    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        callCount++;
        if (callCount === 1) {
          const tool = req.requestTools?.find(t => t.name === 'spawn_agent');
          // Verify via generate call count: if the spawned agent shares the
          // parent's toolpack, the same mock is called for both runs.
          await tool!.execute({ template: 'researcher', task: 'shared toolpack test' });
          return { content: 'done' };
        }
        return { content: 'spawned response' };
      },
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, BASIC_SPAWN_CONFIG);
    await agent.invokeAgent({ message: 'test sharing', conversationId: 'c9' });

    // If a new toolpack were created, the mock would not be called a second time.
    expect(mockToolpack.generate).toHaveBeenCalledTimes(2);
  });
});

// ---- spawn_agents_parallel tests --------------------------------------------

describe('AgentSpawnConfig — spawn_agents_parallel tool', () => {
  let mockToolpack: Toolpack;

  beforeEach(() => {
    mockToolpack = createMockToolpack();
  });

  // --------------------------------------------------------------------------
  it('runs multiple agents concurrently and returns all results', async () => {
    const spawnedTasks: string[] = [];
    let callCount = 0;

    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[]; mode?: ModeConfig | string }) => {
        callCount++;
        if (callCount === 1) {
          const tool = req.requestTools?.find(t => t.name === 'spawn_agents_parallel');
          const result = await tool!.execute({
            tasks: [
              { template: 'researcher', task: 'AI trends' },
              { template: 'writer', task: 'intro paragraph' },
            ],
          });
          const { results } = result as { results: Array<{ output: string }> };
          return { content: results.map(r => r.output).join(' | ') };
        }
        // Each spawned agent — capture the task from its mode's systemPrompt
        const mode = req.mode;
        if (mode && typeof mode === 'object' && 'systemPrompt' in mode) {
          const sp = (mode as ModeConfig).systemPrompt ?? '';
          if (sp.includes('AI trends')) spawnedTasks.push('AI trends');
          if (sp.includes('intro paragraph')) spawnedTasks.push('intro paragraph');
        }
        return { content: `result-${callCount - 1}` };
      },
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, BASIC_SPAWN_CONFIG);
    const result = await agent.invokeAgent({ message: 'run parallel', conversationId: 'p1' });

    // Both tasks ran (generate called 3 times: orchestrator + 2 parallel agents)
    expect(mockToolpack.generate).toHaveBeenCalledTimes(3);
    // Orchestrator received both results joined
    expect(result.output).toBe('result-1 | result-2');
  });

  // --------------------------------------------------------------------------
  it('throws for unknown template in parallel tasks', async () => {
    let capturedTool: RequestToolDefinition | undefined;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        capturedTool = req.requestTools?.find(t => t.name === 'spawn_agents_parallel');
        return { content: 'done' };
      },
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, BASIC_SPAWN_CONFIG);
    await agent.invokeAgent({ message: 'hello', conversationId: 'p2' });

    await expect(
      capturedTool!.execute({
        tasks: [
          { template: 'researcher', task: 'valid' },
          { template: 'nonexistent', task: 'invalid' },
        ],
      }),
    ).rejects.toThrow('Unknown spawn template: "nonexistent"');
  });

  // --------------------------------------------------------------------------
  it('throws when tasks array is empty', async () => {
    let capturedTool: RequestToolDefinition | undefined;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        capturedTool = req.requestTools?.find(t => t.name === 'spawn_agents_parallel');
        return { content: 'done' };
      },
    );

    const agent = new OrchestratorAgent({ toolpack: mockToolpack }, BASIC_SPAWN_CONFIG);
    await agent.invokeAgent({ message: 'hello', conversationId: 'p3' });

    await expect(
      capturedTool!.execute({ tasks: [] }),
    ).rejects.toThrow('spawn_agents_parallel requires at least one task.');
  });

  // --------------------------------------------------------------------------
  it('parallel agents all inherit spawn config for further chaining', async () => {
    let callCount = 0;
    const injectedToolNames: string[][] = [];

    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        callCount++;
        injectedToolNames.push((req.requestTools ?? []).map(t => t.name));
        if (callCount === 1) {
          const tool = req.requestTools?.find(t => t.name === 'spawn_agents_parallel');
          await tool!.execute({
            tasks: [
              { template: 'researcher', task: 'task A' },
              { template: 'writer', task: 'task B' },
            ],
          });
          return { content: 'orchestrated' };
        }
        return { content: 'done' };
      },
    );

    const agent = new OrchestratorAgent(
      { toolpack: mockToolpack },
      { ...BASIC_SPAWN_CONFIG, maxDepth: 3 },
    );
    await agent.invokeAgent({ message: 'parallel chain', conversationId: 'p4' });

    // Both spawned agents at depth 1 should have spawn tools injected (1 < 3)
    expect(injectedToolNames[1]).toContain('spawn_agent');
    expect(injectedToolNames[2]).toContain('spawn_agent');
  });
});

// ---- EphemeralAgent unit tests ----------------------------------------------

describe('EphemeralAgent', () => {
  it('constructs with name, description, mode, and shared toolpack', () => {
    const mockToolpack = createMockToolpack();
    const mode: ModeConfig = { ...CHAT_MODE, name: 'ephemeral-test', systemPrompt: 'test' };
    const agent = new EphemeralAgent('test-ephemeral', 'A test ephemeral', mode, { toolpack: mockToolpack });

    expect(agent.name).toBe('test-ephemeral');
    expect(agent.description).toBe('A test ephemeral');
    expect(agent.mode).toBe(mode);
  });

  it('invokeAgent passes spawnDepth from context into run()', async () => {
    const mockToolpack = createMockToolpack();
    const mode: ModeConfig = { ...CHAT_MODE, name: 'ephemeral-depth-test', systemPrompt: 'test' };
    const agent = new EphemeralAgent('depth-test', 'depth agent', mode, { toolpack: mockToolpack });

    // Inject spawn config so the tool gets injected, then verify depth
    agent.spawn = {
      enabled: true,
      templates: [{ name: 'helper', description: 'h', systemPrompt: () => 'help' }],
      maxDepth: 5,
    };

    let capturedDepthInTools = false;
    (mockToolpack.generate as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: { requestTools?: RequestToolDefinition[] }) => {
        const tool = req.requestTools?.find(t => t.name === 'spawn_agent');
        // At depth 2, tool should still be present (2 < 5)
        capturedDepthInTools = tool !== undefined;
        return { content: 'result' };
      },
    );

    await agent.invokeAgent({
      message: 'work',
      context: { spawnDepth: 2 },
    });

    expect(capturedDepthInTools).toBe(true);
  });
});
