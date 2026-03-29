import { execSync } from 'child_process';
import { ToolDefinition } from '../../../types.js';
import { name, displayName, description, parameters, category } from './schema.js';

async function execute(args: Record<string, any>): Promise<string> {
    const targetPath = (args.path || (process.platform === 'win32' ? 'C:' : '/')) as string;
    const isWindows = process.platform === 'win32';

    try {
        if (isWindows) {
            // Windows: Use PowerShell Get-PSDrive (more reliable than deprecated wmic)
            // Extract drive letter from path (e.g., C:\path -> C)
            const driveMatch = targetPath.match(/^([A-Za-z]):/);
            const driveLetter = driveMatch ? driveMatch[1] : 'C';
            
            const psCommand = `Get-PSDrive -Name ${driveLetter} | Select-Object @{n='Drive';e={$_.Name+':'}},@{n='Used';e={$_.Used}},@{n='Free';e={$_.Free}},@{n='Total';e={$_.Used+$_.Free}} | ConvertTo-Json`;
            const output = execSync(psCommand, {
                encoding: 'utf-8',
                timeout: 5000,
                shell: 'powershell.exe',
            });

            const data = JSON.parse(output.trim());
            const total = data.Total || 0;
            const free = data.Free || 0;
            const used = data.Used || 0;
            const usePercent = total > 0 ? Math.round((used / total) * 100) : 0;

            return JSON.stringify({
                path: targetPath,
                filesystem: 'NTFS',
                size: `${(total / (1024 ** 3)).toFixed(1)}G`,
                used: `${(used / (1024 ** 3)).toFixed(1)}G`,
                available: `${(free / (1024 ** 3)).toFixed(1)}G`,
                usePercent: `${usePercent}%`,
                mountedOn: data.Drive || `${driveLetter}:`,
            }, null, 2);
        } else {
            // Unix: Use df command
            const output = execSync(`df -h "${targetPath}"`, {
                encoding: 'utf-8',
                timeout: 5000,
            });

            // Parse df output
            const lines = output.trim().split('\n');
            if (lines.length < 2) {
                return output;
            }

            const parts = lines[1].split(/\s+/);
            return JSON.stringify({
                path: targetPath,
                filesystem: parts[0],
                size: parts[1],
                used: parts[2],
                available: parts[3],
                usePercent: parts[4],
                mountedOn: parts[5],
            }, null, 2);
        }
    } catch (error: any) {
        throw new Error(`Failed to get disk usage for ${targetPath}: ${error.message}`);
    }
}

export const systemDiskUsageTool: ToolDefinition = {
    name,
    displayName,
    description,
    parameters,
    category,
    execute,
};
