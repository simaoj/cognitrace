import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execSync } from 'child_process';
import {
    LogEntry,
    LogSource,
    appendToLog,
    computeProjectKey,
    extractLogMessage,
} from './log-utils';

function resolveCopilotTranscriptsDir(workspacePath: string): string | null {
    const workspaceStorageRoot = path.join(
        os.homedir(),
        'Library',
        'Application Support',
        'Code',
        'User',
        'workspaceStorage'
    );
    if (!fs.existsSync(workspaceStorageRoot)) { return null; }

    const expectedFolderUri = vscode.Uri.file(workspacePath).toString();
    let entries: fs.Dirent[];
    try {
        entries = fs.readdirSync(workspaceStorageRoot, { withFileTypes: true });
    } catch {
        return null;
    }

    for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        const storageDir = path.join(workspaceStorageRoot, entry.name);
        const workspaceJsonPath = path.join(storageDir, 'workspace.json');
        if (!fs.existsSync(workspaceJsonPath)) { continue; }

        try {
            const workspaceJson = JSON.parse(fs.readFileSync(workspaceJsonPath, 'utf8'));
            if (workspaceJson?.folder === expectedFolderUri) {
                const candidates = [
                    path.join(storageDir, 'chatSessions'),
                    path.join(storageDir, 'GitHub.copilot-chat', 'transcripts'),
                ];

                for (const candidate of candidates) {
                    if (fs.existsSync(candidate)) {
                        return candidate;
                    }
                }

                return candidates[0];
            }
        } catch {
            continue;
        }
    }

    return null;
}

function getCopilotTranscriptsDirIfReady(workspacePath: string): string | null {
    const dir = resolveCopilotTranscriptsDir(workspacePath);
    if (!dir || !fs.existsSync(dir)) { return null; }
    return dir;
}

function getCodexSessionsDirIfReady(): string | null {
    const dir = path.join(os.homedir(), '.codex', 'sessions');
    if (!fs.existsSync(dir)) { return null; }
    return dir;
}

function isCodexSessionForWorkspace(filePath: string, workspacePath: string): boolean {
    const fd = fs.openSync(filePath, 'r');
    try {
        const stat = fs.fstatSync(fd);
        if (stat.size === 0) { return false; }

        const sampleSize = Math.min(stat.size, 16_384);
        const buf = Buffer.alloc(sampleSize);
        fs.readSync(fd, buf, 0, sampleSize, 0);

        for (const line of buf.toString('utf8').split('\n')) {
            if (!line.trim()) { continue; }

            try {
                const msg = JSON.parse(line);
                if (msg.type === 'session_meta') {
                    return msg.payload?.cwd === workspacePath;
                }
            } catch {
                return false;
            }
        }

        return false;
    } catch {
        return false;
    } finally {
        fs.closeSync(fd);
    }
}

function getGitInfo(cwd: string): { branch: string; userName: string; email: string } {
    const run = (cmd: string): string => {
        try {
            return execSync(cmd, { cwd, timeout: 5000 }).toString().trim();
        } catch {
            return '';
        }
    };
    return {
        branch: run('git rev-parse --abbrev-ref HEAD') || 'unknown',
        userName: run('git config --get user.name') || 'unknown',
        email: run('git config --get user.email') || 'unknown',
    };
}


export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Cognitrace');
    context.subscriptions.push(output);

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        output.appendLine('[AI Log] No workspace folder found, aborting.');
        return;
    }

    const workspacePath = workspaceFolder.uri.fsPath;
    const projectKey = computeProjectKey(workspacePath);
    const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);
    const copilotTranscriptsDir = resolveCopilotTranscriptsDir(workspacePath);
    const codexSessionsDir = getCodexSessionsDirIfReady();
    const logDir = path.join(workspacePath, '.ai_log');

    output.appendLine(`[AI Log] Workspace: ${workspacePath}`);
    output.appendLine(`[AI Log] Watching Claude dir: ${claudeProjectDir}`);
    output.appendLine(`[AI Log] Watching Copilot dir: ${copilotTranscriptsDir ?? 'not found'}`);
    output.appendLine(`[AI Log] Watching Codex dir: ${codexSessionsDir ?? 'not found'}`);
    output.appendLine(`[AI Log] Log dir: ${logDir}`);

    // Track the byte offset already read per JSONL file
    const fileOffsets = new Map<string, number>();
    const codexWorkspaceFiles = new Map<string, boolean>();

    function processFile(filePath: string, source: LogSource): void {
        if (!filePath.endsWith('.jsonl')) { return; }

        if (source === 'codex') {
            const knownWorkspaceFile = codexWorkspaceFiles.get(filePath);
            if (knownWorkspaceFile === false) { return; }

            if (knownWorkspaceFile !== true) {
                const isWorkspaceFile = isCodexSessionForWorkspace(filePath, workspacePath);
                codexWorkspaceFiles.set(filePath, isWorkspaceFile);
                if (!isWorkspaceFile) { return; }
            }
        }

        let stat: fs.Stats;
        try { stat = fs.statSync(filePath); } catch { return; }

        const offset = fileOffsets.get(filePath) ?? 0;
        output.appendLine(`[AI Log] processFile: ${path.basename(filePath)} source=${source} size=${stat.size} offset=${offset}`);
        if (stat.size <= offset) { return; }

        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(stat.size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fileOffsets.set(filePath, stat.size);

            for (const line of buf.toString('utf8').split('\n')) {
                if (!line.trim()) { continue; }
                const message = extractLogMessage(line, source);
                if (!message) { continue; }

                const git = getGitInfo(workspacePath);
                const entry: LogEntry = {
                    timestamp: new Date().toISOString(),
                    source,
                    git_branch: git.branch,
                    git_user_name: git.userName,
                    call_context: { cwd: workspacePath },
                    role: message.role,
                    content: message.content,
                };
                output.appendLine(`[AI Log] Logged ${entry.role}: ${entry.content.slice(0, 60)}...`);
                appendToLog(logDir, entry);
            }
        } finally {
            fs.closeSync(fd);
        }
    }

    // Watch individual JSONL files directly (more reliable than directory watching on macOS)
    const fileWatchers = new Map<string, fs.FSWatcher>();
    const pendingWatcherRetries = new Map<string, NodeJS.Timeout>();

    function watchFile(filePath: string, source: LogSource): void {
        const key = `${source}:${filePath}`;
        if (fileWatchers.has(key)) { return; }
        try {
            const watcher = fs.watch(filePath, { persistent: false }, () => {
                processFile(filePath, source);
            });
            fileWatchers.set(key, watcher);
            context.subscriptions.push({ dispose: () => { watcher.close(); fileWatchers.delete(key); } });
        } catch { /* file may have been removed */ }
    }

    function scanDir(dir: string, source: LogSource, recursive = false): void {
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) {
                    if (recursive) {
                        scanDir(full, source, true);
                    }
                    continue;
                }

                if (entry.name.endsWith('.jsonl')) {
                    processFile(full, source);
                    watchFile(full, source);
                }
            }
        } catch { /* dir not readable */ }
    }

    function startWatcher(dir: string, source: LogSource, label: string, recursiveScan = false): void {
        const dirExists = fs.existsSync(dir);
        if (!dirExists) {
            const retryKey = `${source}:${dir}`;
            if (!pendingWatcherRetries.has(retryKey)) {
                output.appendLine(`[AI Log] ${label} dir not ready yet, waiting: ${dir}`);
            }
            const retry = setTimeout(() => {
                pendingWatcherRetries.delete(retryKey);
                if (source === 'github_copilot') {
                    const readyDir = getCopilotTranscriptsDirIfReady(workspacePath);
                    if (readyDir) {
                        startWatcher(readyDir, source, label, recursiveScan);
                        return;
                    }
                }
                if (source === 'codex') {
                    const readyDir = getCodexSessionsDirIfReady();
                    if (readyDir) {
                        startWatcher(readyDir, source, label, recursiveScan);
                        return;
                    }
                }
                startWatcher(dir, source, label, recursiveScan);
            }, 15_000);
            pendingWatcherRetries.set(retryKey, retry);
            context.subscriptions.push({ dispose: () => { clearTimeout(retry); pendingWatcherRetries.delete(retryKey); } });
            return;
        }

        output.appendLine(`[AI Log] Starting ${label} watcher on: ${dir}`);
        // Initial scan of existing files
        scanDir(dir, source, recursiveScan);

        // Watch directory for new JSONL files being created
        const dirWatcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
            output.appendLine(`[AI Log] ${label} dir event: event=${_event} file=${filename}`);
            if (filename && filename.endsWith('.jsonl')) {
                const full = path.join(dir, filename);
                processFile(full, source);
                watchFile(full, source);
            } else if (!filename) {
                // macOS sometimes omits filename — rescan everything
                scanDir(dir, source, recursiveScan);
            }
        });
        context.subscriptions.push({ dispose: () => dirWatcher.close() });

        // Fallback polling every 10s in case fs.watch misses events
        const poll = setInterval(() => scanDir(dir, source, recursiveScan), 10_000);
        context.subscriptions.push({ dispose: () => clearInterval(poll) });
    }

    startWatcher(claudeProjectDir, 'claude', 'Claude');
    const startCopilot = (): void => {
        const readyCopilotDir = getCopilotTranscriptsDirIfReady(workspacePath);
        if (readyCopilotDir) {
            startWatcher(readyCopilotDir, 'github_copilot', 'Copilot');
            return;
        }

        const retryKey = 'github_copilot:workspace';
        if (!pendingWatcherRetries.has(retryKey)) {
            output.appendLine('[AI Log] Copilot transcripts dir not ready yet, waiting for first session...');
        }
        const retry = setTimeout(() => {
            pendingWatcherRetries.delete(retryKey);
            startCopilot();
        }, 15_000);
        pendingWatcherRetries.set(retryKey, retry);
        context.subscriptions.push({ dispose: () => { clearTimeout(retry); pendingWatcherRetries.delete(retryKey); } });
    };
    startCopilot();
    const startCodex = (): void => {
        const readyCodexDir = getCodexSessionsDirIfReady();
        if (readyCodexDir) {
            startWatcher(readyCodexDir, 'codex', 'Codex', true);
            return;
        }

        const retryKey = 'codex:workspace';
        if (!pendingWatcherRetries.has(retryKey)) {
            output.appendLine('[AI Log] Codex sessions dir not ready yet, waiting for first session...');
        }
        const retry = setTimeout(() => {
            pendingWatcherRetries.delete(retryKey);
            startCodex();
        }, 15_000);
        pendingWatcherRetries.set(retryKey, retry);
        context.subscriptions.push({ dispose: () => { clearTimeout(retry); pendingWatcherRetries.delete(retryKey); } });
    };
    startCodex();
}

export function deactivate(): void {}
