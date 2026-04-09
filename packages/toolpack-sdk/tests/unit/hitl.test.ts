import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { AIClient } from '../../src/client';
import { ProviderAdapter, CompletionRequest, CompletionResponse, CompletionChunk, EmbeddingRequest, EmbeddingResponse } from '../../src/providers/base';
import { ToolDefinition } from '../../src/tools/types';
import { HitlConfig } from '../../src/providers/config';

// Mock provider for testing
class MockProvider implements ProviderAdapter {
    async generate(request: CompletionRequest): Promise<CompletionResponse> {
        return { content: 'mock response' };
    }
    async *stream(request: CompletionRequest): AsyncGenerator<CompletionChunk> {
        yield { delta: 'mock' };
        yield { finish_reason: 'stop' };
    }
    async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
        return { embeddings: [] };
    }
}

// Helper to create a mock tool with confirmation
function createMockTool(name: string, level: 'high' | 'medium' | undefined, category: string = 'filesystem'): ToolDefinition {
    return {
        name,
        displayName: name,
        description: `Test ${name}`,
        parameters: { type: 'object', properties: {}, required: [] },
        category,
        execute: async () => 'executed',
        ...(level && {
            confirmation: {
                level,
                reason: `This is a ${level} risk operation`,
                showArgs: ['path'],
            },
        }),
    };
}

describe('HITL - isBypassed Logic', () => {
    it('should bypass when HITL config is undefined', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
        });

        const tool = createMockTool('fs.delete_file', 'high');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(true);
    });

    it('should bypass when HITL is explicitly disabled', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: { enabled: false },
        });

        const tool = createMockTool('fs.delete_file', 'high');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(true);
    });

    it('should NOT bypass when HITL enabled is undefined (default to enabled)', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: { bypass: {} },
        });

        const tool = createMockTool('fs.delete_file', 'high');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(false);
    });

    it('should NOT bypass when HITL is explicitly enabled', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: { enabled: true },
        });

        const tool = createMockTool('fs.delete_file', 'high');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(false);
    });
});

describe('HITL - Bypass Rule Matching', () => {
    it('should bypass when tool is in bypass.tools list', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                bypass: {
                    tools: ['fs.write_file'],
                },
            },
        });

        const tool = createMockTool('fs.write_file', 'high');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(true);
    });

    it('should NOT bypass when tool is not in bypass.tools list', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                bypass: {
                    tools: ['fs.write_file'],
                },
            },
        });

        const tool = createMockTool('fs.delete_file', 'high');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(false);
    });

    it('should bypass when tool category is in bypass.categories list', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                bypass: {
                    categories: ['filesystem'],
                },
            },
        });

        const tool = createMockTool('fs.write_file', 'high', 'filesystem');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(true);
    });

    it('should bypass when tool level is in bypass.levels list', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                bypass: {
                    levels: ['high'],
                },
            },
        });

        const tool = createMockTool('fs.delete_file', 'high');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(true);
    });

    it('should NOT bypass when tool level does not match bypass.levels', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                bypass: {
                    levels: ['medium'],
                },
            },
        });

        const tool = createMockTool('fs.delete_file', 'high');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(false);
    });

    it('should handle tool without confirmation metadata', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                bypass: {
                    levels: ['high'],
                },
            },
        });

        const tool = createMockTool('fs.read_file', undefined, 'filesystem');
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(false); // No confirmation metadata = not bypassed, executes normally
    });
});

describe('HITL - Confirmation Mode Filtering', () => {
    it('should bypass all tools when mode is "off"', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                confirmationMode: 'off',
            },
        });

        const highRiskTool = createMockTool('fs.delete_file', 'high');
        const mediumRiskTool = createMockTool('db.insert', 'medium');

        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(highRiskTool)).toBe(true);
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(mediumRiskTool)).toBe(true);
    });

    it('should bypass medium-risk tools when mode is "high-only"', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                confirmationMode: 'high-only',
            },
        });

        const highRiskTool = createMockTool('fs.delete_file', 'high');
        const mediumRiskTool = createMockTool('db.insert', 'medium');

        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(highRiskTool)).toBe(false); // High risk = confirm
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(mediumRiskTool)).toBe(true); // Medium risk = bypass
    });

    it('should confirm all risk levels when mode is "all" (default)', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                confirmationMode: 'all',
            },
        });

        const highRiskTool = createMockTool('fs.delete_file', 'high');
        const mediumRiskTool = createMockTool('db.insert', 'medium');

        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(highRiskTool)).toBe(false);
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(mediumRiskTool)).toBe(false);
    });
});

describe('HITL - updateHitlConfig', () => {
    it('should update HITL config dynamically', () => {
        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig: {
                enabled: true,
                bypass: {},
            },
        });

        const tool = createMockTool('fs.write_file', 'high');

        // Initially not bypassed
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(false);

        // Update config to add bypass rule
        client.updateHitlConfig({
            enabled: true,
            bypass: {
                tools: ['fs.write_file'],
            },
        });

        // Now should be bypassed
        // @ts-ignore - accessing private method for testing
        expect(client.isBypassed(tool)).toBe(true);
    });

    it('should get current HITL config', () => {
        const hitlConfig: HitlConfig = {
            enabled: true,
            confirmationMode: 'high-only',
            bypass: {
                tools: ['fs.write_file'],
            },
        };

        const client = new AIClient({
            providers: { mock: new MockProvider() },
            defaultProvider: 'mock',
            hitlConfig,
        });

        expect(client.getHitlConfig()).toEqual(hitlConfig);
    });
});
