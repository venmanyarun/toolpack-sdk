import { execSync } from 'child_process';
import { ToolDefinition } from '../types.js';
import { logDebug } from '../../providers/provider-logger.js';

function runKubectl(args: string[], stdin?: string): string {
    const command = ['kubectl', ...args].join(' ');
    logDebug(`[k8s-tools] execute: ${command}`);

    try {
        const output = execSync(command, {
            input: stdin,
            encoding: 'utf-8',
            maxBuffer: 10 * 1024 * 1024,
            stdio: ['pipe', 'pipe', 'pipe'],
            timeout: 30000,
        });
        return output || '(kubectl completed with no output)';
    } catch (error: any) {
        const stdout = error.stdout || '';
        const stderr = error.stderr || '';
        const status = error.status ?? 'unknown';
        return `kubectl failed (exit code ${status})\nSTDOUT:\n${stdout}\nSTDERR:\n${stderr}`;
    }
}

const category = 'kubernetes';

export const k8sListPodsTool: ToolDefinition = {
    name: 'k8s.list_pods',
    displayName: 'Kubernetes List Pods',
    description: 'List pods in the current or a specific Kubernetes namespace.',
    category,
    parameters: {
        type: 'object',
        properties: {
            namespace: { type: 'string', description: 'Namespace to query. If omitted, uses the current namespace.' },
            labels: { type: 'string', description: 'Label selector to filter pods.', },
            allNamespaces: { type: 'boolean', description: 'If true, list pods across all namespaces.', default: false },
        },
        required: [],
    },
    execute: async (args: Record<string, any>) => {
        const command = ['get', 'pods', '-o', 'wide'];
        if (args.allNamespaces) command.push('--all-namespaces');
        if (args.namespace && !args.allNamespaces) command.push('-n', args.namespace);
        if (args.labels) command.push('-l', args.labels);
        return runKubectl(command);
    },
};

export const k8sDescribeTool: ToolDefinition = {
    name: 'k8s.describe',
    displayName: 'Kubernetes Describe Resource',
    description: 'Describe a Kubernetes resource or resource instance.',
    category,
    parameters: {
        type: 'object',
        properties: {
            resource: { type: 'string', description: 'Resource type to describe, such as pod, service, deployment.', },
            name: { type: 'string', description: 'Resource name. Optional for cluster-wide descriptions.', },
            namespace: { type: 'string', description: 'Namespace containing the resource.', },
        },
        required: ['resource'],
    },
    execute: async (args: Record<string, any>) => {
        const command = ['describe', args.resource as string];
        if (args.name) command.push(args.name as string);
        if (args.namespace) command.push('-n', args.namespace as string);
        return runKubectl(command);
    },
};

export const k8sGetLogsTool: ToolDefinition = {
    name: 'k8s.get_logs',
    displayName: 'Kubernetes Get Pod Logs',
    description: 'Fetch logs from a Kubernetes pod, optionally from a specific container.',
    category,
    parameters: {
        type: 'object',
        properties: {
            podName: { type: 'string', description: 'The name of the pod to fetch logs from.' },
            namespace: { type: 'string', description: 'Namespace of the pod.', },
            container: { type: 'string', description: 'Container name inside the pod.', },
            tailLines: { type: 'integer', description: 'Number of log lines to show from the end.', default: 100 },
            since: { type: 'string', description: 'Return logs newer than a relative duration like 5m or 1h.', },
        },
        required: ['podName'],
    },
    execute: async (args: Record<string, any>) => {
        const command = ['logs', args.podName as string];
        if (args.container) command.push('-c', args.container as string);
        if (args.namespace) command.push('-n', args.namespace as string);
        if (typeof args.tailLines === 'number') command.push('--tail', `${args.tailLines}`);
        if (args.since) command.push('--since', args.since as string);
        return runKubectl(command);
    },
};

export const k8sApplyManifestTool: ToolDefinition = {
    name: 'k8s.apply_manifest',
    displayName: 'Kubernetes Apply Manifest',
    description: 'Apply a Kubernetes manifest from a file path or inline YAML content.',
    category,
    parameters: {
        type: 'object',
        properties: {
            path: { type: 'string', description: 'Path to the manifest file to apply.', },
            manifest: { type: 'string', description: 'Inline YAML manifest to apply if no path is provided.', },
            namespace: { type: 'string', description: 'Namespace to apply the manifest into, if supported by the manifest.', },
        },
        required: [],
    },
    confirmation: {
        level: 'high',
        reason: 'This will change cluster state by applying a Kubernetes manifest.',
        showArgs: ['path', 'namespace'],
    },
    execute: async (args: Record<string, any>) => {
        const path = args.path as string | undefined;
        const manifest = args.manifest as string | undefined;
        const command = ['apply', '-f'];
        if (path) {
            command.push(path);
            if (args.namespace) command.push('-n', args.namespace as string);
            return runKubectl(command);
        }

        if (!manifest) {
            throw new Error('Either path or manifest is required to apply a Kubernetes manifest.');
        }

        if (args.namespace) command.push('-n', args.namespace as string);
        command.push('-');
        return runKubectl(command, manifest);
    },
};

export const k8sDeleteResourceTool: ToolDefinition = {
    name: 'k8s.delete_resource',
    displayName: 'Kubernetes Delete Resource',
    description: 'Delete a Kubernetes resource by type and name, or delete resources from a manifest file.',
    category,
    parameters: {
        type: 'object',
        properties: {
            resource: { type: 'string', description: 'Resource type to delete, such as pod, service, deployment.', },
            name: { type: 'string', description: 'Name of the resource to delete.', },
            namespace: { type: 'string', description: 'Namespace containing the resource.', },
            path: { type: 'string', description: 'Path to a manifest file that contains the resources to delete.', },
            force: { type: 'boolean', description: 'Force deletion of the resource.', default: false },
        },
        required: [],
    },
    confirmation: {
        level: 'high',
        reason: 'This will delete resources from the Kubernetes cluster.',
        showArgs: ['resource', 'name', 'path'],
    },
    execute: async (args: Record<string, any>) => {
        const path = args.path as string | undefined;
        const resource = args.resource as string | undefined;
        const name = args.name as string | undefined;

        if (path) {
            return runKubectl(['delete', '-f', path]);
        }

        if (!resource || !name) {
            throw new Error('resource and name are required unless a manifest path is provided.');
        }

        const command = ['delete', resource, name];
        if (args.namespace) command.push('-n', args.namespace as string);
        if (args.force) command.push('--force', '--grace-period=0');
        return runKubectl(command);
    },
};

export const k8sListServicesTool: ToolDefinition = {
    name: 'k8s.list_services',
    displayName: 'Kubernetes List Services',
    description: 'List services in the current or a specific Kubernetes namespace.',
    category,
    parameters: {
        type: 'object',
        properties: {
            namespace: { type: 'string', description: 'Namespace to query. If omitted, uses the current namespace.' },
            allNamespaces: { type: 'boolean', description: 'List services across all namespaces.', default: false },
        },
        required: [],
    },
    execute: async (args: Record<string, any>) => {
        const command = ['get', 'services', '-o', 'wide'];
        if (args.allNamespaces) command.push('--all-namespaces');
        if (args.namespace && !args.allNamespaces) command.push('-n', args.namespace as string);
        return runKubectl(command);
    },
};

export const k8sListDeploymentsTool: ToolDefinition = {
    name: 'k8s.list_deployments',
    displayName: 'Kubernetes List Deployments',
    description: 'List deployments in the current or a specific Kubernetes namespace.',
    category,
    parameters: {
        type: 'object',
        properties: {
            namespace: { type: 'string', description: 'Namespace to query. If omitted, uses the current namespace.' },
            labels: { type: 'string', description: 'Label selector to filter deployments.', },
            allNamespaces: { type: 'boolean', description: 'List deployments across all namespaces.', default: false },
        },
        required: [],
    },
    execute: async (args: Record<string, any>) => {
        const command = ['get', 'deployments', '-o', 'wide'];
        if (args.allNamespaces) command.push('--all-namespaces');
        if (args.namespace && !args.allNamespaces) command.push('-n', args.namespace as string);
        if (args.labels) command.push('-l', args.labels as string);
        return runKubectl(command);
    },
};

export const k8sGetConfigMapTool: ToolDefinition = {
    name: 'k8s.get_config_map',
    displayName: 'Kubernetes Get ConfigMap',
    description: 'Retrieve a ConfigMap from a Kubernetes namespace.',
    category,
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'ConfigMap name.', },
            namespace: { type: 'string', description: 'Namespace containing the ConfigMap.', },
            output: { type: 'string', description: 'Output format, such as yaml or json.', enum: ['yaml', 'json'], default: 'yaml' },
        },
        required: ['name'],
    },
    execute: async (args: Record<string, any>) => {
        const command = ['get', 'configmap', args.name as string, '-o', args.output as string || 'yaml'];
        if (args.namespace) command.push('-n', args.namespace as string);
        return runKubectl(command);
    },
};

export const k8sSwitchContextTool: ToolDefinition = {
    name: 'k8s.switch_context',
    displayName: 'Kubernetes Switch Context',
    description: 'Switch the active kubectl context to a different Kubernetes cluster or namespace configuration.',
    category,
    parameters: {
        type: 'object',
        properties: {
            context: { type: 'string', description: 'The kubeconfig context to switch to.', },
        },
        required: ['context'],
    },
    execute: async (args: Record<string, any>) => {
        return runKubectl(['config', 'use-context', args.context as string]);
    },
};

export const k8sGetNamespacesTool: ToolDefinition = {
    name: 'k8s.get_namespaces',
    displayName: 'Kubernetes Get Namespaces',
    description: 'List namespaces in the current Kubernetes context.',
    category,
    parameters: {
        type: 'object',
        properties: {},
        required: [],
    },
    execute: async () => runKubectl(['get', 'namespaces', '-o', 'wide']),
};

export const k8sWaitForDeploymentTool: ToolDefinition = {
    name: 'k8s.wait_for_deployment',
    displayName: 'Kubernetes Wait For Deployment',
    description: 'Wait for a Kubernetes deployment to complete its rollout.',
    category,
    parameters: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Deployment name to wait for.', },
            namespace: { type: 'string', description: 'Namespace containing the deployment.', },
            timeout: { type: 'string', description: 'Timeout duration, e.g. 300s or 5m.', default: '300s' },
        },
        required: ['name'],
    },
    execute: async (args: Record<string, any>) => {
        const command = ['rollout', 'status', `deployment/${args.name as string}`, '--timeout', args.timeout as string || '300s'];
        if (args.namespace) command.push('-n', args.namespace as string);
        return runKubectl(command);
    },
};
