import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
    LogEntry,
    LogSource,
    appendToLog,
    buildLogFilePath,
    buildTerminalContent,
    classifyExitCode,
    computeProjectKey,
    deriveSessionId,
    extractLogMessages,
    MAX_TERMINAL_OUTPUT_CHARS,
    shouldLogFileChange,
} from './log-utils';
import { API_BASE_URL, postLogEntry } from './api-client';
import { ConfigViewProvider } from './config-view';

function resolveCopilotTranscriptsDir(workspacePath: string): string | null {
    const workspaceStorageRoot = path.join(getVSCodeUserDataDir(), 'workspaceStorage');
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

function isAntigravitySessionForWorkspace(filePath: string, workspacePath: string): boolean {
    try {
        const content = fs.readFileSync(filePath, 'utf8');
        return content.includes(workspacePath);
    } catch {
        return false;
    }
}

function getVSCodeUserDataDir(): string {
    const platform = os.platform();
    if (platform === 'win32') {
        return path.join(os.homedir(), 'AppData', 'Roaming', 'Code', 'User');
    } else if (platform === 'darwin') {
        return path.join(os.homedir(), 'Library', 'Application Support', 'Code', 'User');
    } else {
        return path.join(os.homedir(), '.config', 'Code', 'User');
    }
}

function isLoggingEnabled(workspaceFolder: vscode.WorkspaceFolder): boolean {
    return vscode.workspace
        .getConfiguration('cognitrace', workspaceFolder.uri)
        .get<boolean>('enabled', false);
}

function getManualCode(workspaceFolder: vscode.WorkspaceFolder): string {
    return vscode.workspace.getConfiguration('cognitrace', workspaceFolder.uri).get<string>('userIdManualCode', '').trim();
}

function getProjectId(workspaceFolder: vscode.WorkspaceFolder): string | undefined {
    const projectId = vscode.workspace.getConfiguration('cognitrace', workspaceFolder.uri).get<string>('projectId', '').trim();
    return projectId || undefined;
}

function resolveUserId(workspaceFolder: vscode.WorkspaceFolder): string {
    return getManualCode(workspaceFolder) || 'unknown';
}

// Whether captured entries get written to .ai_log/ at all — independent of whether they're also
// synced to the API (see sendToApi below): a user can save locally only, sync only, both, or
// (degenerate but harmless) neither.
function isSaveLocallyEnabled(workspaceFolder: vscode.WorkspaceFolder): boolean {
    return vscode.workspace.getConfiguration('cognitrace', workspaceFolder.uri).get<boolean>('saveLocally', true);
}

// file_change and terminal entries have no session of their own (see LogEntry.session_id), but
// tagging them with whichever AI session was most recently active lets you correlate a save or a
// command with the conversation that likely prompted it. Best-effort: it's just "most recently
// processed", not a guarantee that session is actually related to this particular event.
interface SessionTracker {
    lastSessionId?: string;
}

// Tracks, per log file, how many of its entries have already reached the API — so a later
// backfill (see below) knows where to resume instead of re-sending everything from scratch.
const SYNCED_COUNT_PREFIX = 'cognitrace.syncedCount:';

function getSyncedCount(context: vscode.ExtensionContext, logFilePath: string): number {
    return context.workspaceState.get<number>(SYNCED_COUNT_PREFIX + logFilePath, 0);
}

async function markSyncedCount(context: vscode.ExtensionContext, logFilePath: string, count: number): Promise<void> {
    // Entries can be sent concurrently (fire-and-forget) and finish out of order, so only ever
    // move the marker forward.
    if (count > getSyncedCount(context, logFilePath)) {
        await context.workspaceState.update(SYNCED_COUNT_PREFIX + logFilePath, count);
    }
}

// Tracks, per watched source file (a Claude/Copilot/Codex/Antigravity transcript), how many bytes
// have already been read — persisted across restarts so a fresh activation resumes from where it
// left off instead of re-scanning each file from byte 0, which would re-append and re-send every
// historical entry as a duplicate (the in-memory-only offset map used to reset on every activation).
const FILE_OFFSET_PREFIX = 'cognitrace.fileOffset:';

function getPersistedOffset(context: vscode.ExtensionContext, filePath: string): number {
    return context.workspaceState.get<number>(FILE_OFFSET_PREFIX + filePath, 0);
}

async function persistOffset(context: vscode.ExtensionContext, filePath: string, offset: number): Promise<void> {
    if (offset > getPersistedOffset(context, filePath)) {
        await context.workspaceState.update(FILE_OFFSET_PREFIX + filePath, offset);
    }
}

// Fire-and-forget: local logging must never be blocked or broken by the remote API being
// unreachable or simply not built into this copy of the extension (API_BASE_URL is baked in at
// build time — see api-client.ts). Syncing isn't a separate toggle: it fires automatically
// whenever a user code is set, using that code as the API key too — no code means no sync.
// entryCount is undefined when the entry wasn't saved locally, in which case there's no file to
// track a synced count against.
async function sendToApi(
    entry: LogEntry,
    workspaceFolder: vscode.WorkspaceFolder,
    context: vscode.ExtensionContext,
    output: vscode.OutputChannel,
    logDir: string,
    entryCount: number | undefined
): Promise<void> {
    if (!API_BASE_URL) { return; }

    const userCode = getManualCode(workspaceFolder);
    if (!userCode) { return; }

    try {
        await postLogEntry({ apiUrl: API_BASE_URL, apiKey: userCode }, entry);
        if (entryCount !== undefined) {
            await markSyncedCount(context, buildLogFilePath(logDir, entry), entryCount);
        }
    } catch (err) {
        output.appendLine(`[AI Log] Failed to send entry to API: ${err instanceof Error ? err.message : String(err)}`);
    }
}

// Uploads entries that were already sitting in .ai_log/ before remote sync was configured (or
// before this workspace was opened), so turning sync on backfills history instead of only
// covering entries captured from that point forward. Resumes from the per-file synced count, so
// it's safe to call repeatedly (on startup, and whenever the relevant settings change).
let backfillInFlight = false;

async function backfillPreviousLogs(
    output: vscode.OutputChannel,
    workspaceFolder: vscode.WorkspaceFolder,
    context: vscode.ExtensionContext,
    logDir: string
): Promise<void> {
    if (backfillInFlight) { return; }
    if (!API_BASE_URL) { return; }

    const userCode = getManualCode(workspaceFolder);
    if (!userCode) { return; }

    let fileNames: string[];
    try {
        fileNames = fs.readdirSync(logDir).filter(f => f.endsWith('.json'));
    } catch {
        return;
    }
    if (!fileNames.length) { return; }

    backfillInFlight = true;
    try {
        for (const fileName of fileNames) {
            const filePath = path.join(logDir, fileName);
            let entries: LogEntry[];
            try {
                entries = JSON.parse(fs.readFileSync(filePath, 'utf8'));
            } catch {
                continue;
            }

            const alreadySynced = getSyncedCount(context, filePath);
            if (alreadySynced >= entries.length) { continue; }

            output.appendLine(`[AI Log] Backfilling ${entries.length - alreadySynced} previous entr${entries.length - alreadySynced === 1 ? 'y' : 'ies'} from ${fileName}...`);
            for (let i = alreadySynced; i < entries.length; i++) {
                try {
                    await postLogEntry({ apiUrl: API_BASE_URL, apiKey: userCode }, entries[i]);
                    await markSyncedCount(context, filePath, i + 1);
                } catch (err) {
                    output.appendLine(`[AI Log] Failed to backfill entry ${i} from ${fileName}: ${err instanceof Error ? err.message : String(err)}`);
                    break; // stop this file here; the next trigger will resume from this point
                }
            }
        }
    } finally {
        backfillInFlight = false;
    }
}

export function activate(context: vscode.ExtensionContext): void {
    const output = vscode.window.createOutputChannel('Cognitrace');
    context.subscriptions.push(output);

    context.subscriptions.push(
        vscode.window.registerWebviewViewProvider(ConfigViewProvider.viewType, new ConfigViewProvider())
    );

    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
        output.appendLine('[AI Log] No workspace folder found, aborting.');
        return;
    }

    const workspacePath = workspaceFolder.uri.fsPath;

    let loggingSession: vscode.Disposable | undefined;

    function syncLoggingState(): void {
        const enabled = isLoggingEnabled(workspaceFolder!);
        if (enabled && !loggingSession) {
            output.appendLine('[AI Log] Logging enabled for this project — starting watchers.');
            loggingSession = startLogging(output, workspaceFolder!, context);
        } else if (!enabled && loggingSession) {
            output.appendLine('[AI Log] Logging disabled for this project — stopping watchers.');
            loggingSession.dispose();
            loggingSession = undefined;
        }
    }

    const logDir = path.join(workspacePath, '.ai_log');

    // The user code can be set (or changed) without disabling and re-enabling logging — so
    // trigger a backfill directly whenever it changes, in addition to the one that already runs
    // each time watchers start up.
    context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('cognitrace.enabled', workspaceFolder.uri)) {
            syncLoggingState();
        }
        if (
            e.affectsConfiguration('cognitrace.userIdManualCode', workspaceFolder.uri) &&
            isLoggingEnabled(workspaceFolder)
        ) {
            void backfillPreviousLogs(output, workspaceFolder, context, logDir);
        }
    }));
    context.subscriptions.push({ dispose: () => loggingSession?.dispose() });

    if (!isLoggingEnabled(workspaceFolder)) {
        output.appendLine('[AI Log] Logging is disabled for this project. Enable it from the Cognitrace icon in the Activity Bar.');
    }
    syncLoggingState();
}

function startLogging(output: vscode.OutputChannel, workspaceFolder: vscode.WorkspaceFolder, context: vscode.ExtensionContext): vscode.Disposable {
    const workspacePath = workspaceFolder.uri.fsPath;
    const disposables: vscode.Disposable[] = [];
    function register<T extends vscode.Disposable>(disposable: T): T {
        disposables.push(disposable);
        return disposable;
    }

    const projectKey = computeProjectKey(workspacePath);
    const claudeProjectDir = path.join(os.homedir(), '.claude', 'projects', projectKey);
    const copilotTranscriptsDir = resolveCopilotTranscriptsDir(workspacePath);
    const codexSessionsDir = getCodexSessionsDirIfReady();
    const antigravityBrainDir = path.join(os.homedir(), '.gemini', 'antigravity', 'brain');
    const logDir = path.join(workspacePath, '.ai_log');

    output.appendLine(`[AI Log] Workspace: ${workspacePath}`);
    output.appendLine(`[AI Log] Watching Claude dir: ${claudeProjectDir}`);
    output.appendLine(`[AI Log] Watching Copilot dir: ${copilotTranscriptsDir ?? 'not found'}`);
    output.appendLine(`[AI Log] Watching Codex dir: ${codexSessionsDir ?? 'not found'}`);
    output.appendLine(`[AI Log] Watching Antigravity dir: ${fs.existsSync(antigravityBrainDir) ? antigravityBrainDir : 'not found'}`);
    output.appendLine(`[AI Log] Log dir: ${logDir}`);

    // Track the byte offset already read per JSONL file
    const fileOffsets = new Map<string, number>();
    const codexWorkspaceFiles = new Map<string, boolean>();
    const antigravityWorkspaceFiles = new Map<string, boolean>();
    const antigravityLastCheckedSize = new Map<string, number>();
    const sessionTracker: SessionTracker = {};

    function processFile(filePath: string, source: LogSource): void {
        if (!filePath.endsWith('.jsonl') && !filePath.endsWith('overview.txt')) { return; }

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

        if (source === 'antigravity' && antigravityWorkspaceFiles.get(filePath) !== true) {
            const lastChecked = antigravityLastCheckedSize.get(filePath) ?? 0;
            if (stat.size <= lastChecked) { return; }
            
            const isWorkspaceFile = isAntigravitySessionForWorkspace(filePath, workspacePath);
            antigravityLastCheckedSize.set(filePath, stat.size);
            if (isWorkspaceFile) {
                antigravityWorkspaceFiles.set(filePath, true);
            } else {
                return;
            }
        }

        let offset = fileOffsets.get(filePath);
        if (offset === undefined) {
            offset = getPersistedOffset(context, filePath);
            fileOffsets.set(filePath, offset);
        }
        output.appendLine(`[AI Log] processFile: ${path.basename(filePath)} source=${source} size=${stat.size} offset=${offset}`);
        if (stat.size <= offset) { return; }

        const sessionId = deriveSessionId(filePath, source);

        const fd = fs.openSync(filePath, 'r');
        try {
            const buf = Buffer.alloc(stat.size - offset);
            fs.readSync(fd, buf, 0, buf.length, offset);
            fileOffsets.set(filePath, stat.size);
            void persistOffset(context, filePath, stat.size);

            for (const line of buf.toString('utf8').split('\n')) {
                if (!line.trim()) { continue; }
                const messages = extractLogMessages(line, source);
                if (!messages.length) { continue; }

                sessionTracker.lastSessionId = sessionId;

                const userId = resolveUserId(workspaceFolder);
                const saveLocally = isSaveLocallyEnabled(workspaceFolder);
                for (const message of messages) {
                    const entry: LogEntry = {
                        timestamp: message.timestamp ?? new Date().toISOString(),
                        source,
                        session_id: sessionId,
                        user_id: userId,
                        call_context: { cwd: workspacePath },
                        role: message.role,
                        content: message.content,
                        project_id: getProjectId(workspaceFolder),
                    };
                    output.appendLine(`[AI Log] Logged ${entry.role}: ${entry.content.slice(0, 60)}...`);
                    const entryCount = saveLocally ? appendToLog(logDir, entry) : undefined;
                    void sendToApi(entry, workspaceFolder, context, output, logDir, entryCount);
                }
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
            register({ dispose: () => { watcher.close(); fileWatchers.delete(key); } });
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

                if (entry.name.endsWith('.jsonl') || entry.name === 'overview.txt') {
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
            register({ dispose: () => { clearTimeout(retry); pendingWatcherRetries.delete(retryKey); } });
            return;
        }

        output.appendLine(`[AI Log] Starting ${label} watcher on: ${dir}`);
        // Initial scan of existing files
        scanDir(dir, source, recursiveScan);

        // Watch directory for new JSONL files being created
        const dirWatcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
            output.appendLine(`[AI Log] ${label} dir event: event=${_event} file=${filename}`);
            if (filename && (filename.endsWith('.jsonl') || filename === 'overview.txt')) {
                const full = path.join(dir, filename);
                processFile(full, source);
                watchFile(full, source);
            } else if (!filename) {
                // macOS sometimes omits filename — rescan everything
                scanDir(dir, source, recursiveScan);
            }
        });
        register({ dispose: () => dirWatcher.close() });

        // Fallback polling every 10s in case fs.watch misses events
        const poll = setInterval(() => scanDir(dir, source, recursiveScan), 10_000);
        register({ dispose: () => clearInterval(poll) });
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
        register({ dispose: () => { clearTimeout(retry); pendingWatcherRetries.delete(retryKey); } });
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
        register({ dispose: () => { clearTimeout(retry); pendingWatcherRetries.delete(retryKey); } });
    };
    startCodex();

    const startAntigravity = (): void => {
        if (fs.existsSync(antigravityBrainDir)) {
            startWatcher(antigravityBrainDir, 'antigravity', 'Antigravity', true);
            return;
        }

        const retryKey = 'antigravity:workspace';
        if (!pendingWatcherRetries.has(retryKey)) {
            output.appendLine('[AI Log] Antigravity brain dir not ready yet, waiting for first session...');
        }
        const retry = setTimeout(() => {
            pendingWatcherRetries.delete(retryKey);
            startAntigravity();
        }, 15_000);
        pendingWatcherRetries.set(retryKey, retry);
        register({ dispose: () => { clearTimeout(retry); pendingWatcherRetries.delete(retryKey); } });
    };
    startAntigravity();

    startTerminalWatcher(output, workspaceFolder, context, logDir, sessionTracker, register);
    startFileChangeWatcher(output, workspaceFolder, context, logDir, sessionTracker, register);

    void backfillPreviousLogs(output, workspaceFolder, context, logDir);

    return { dispose: () => { for (const disposable of disposables) { disposable.dispose(); } } };
}

function startFileChangeWatcher(
    output: vscode.OutputChannel,
    workspaceFolder: vscode.WorkspaceFolder,
    context: vscode.ExtensionContext,
    logDir: string,
    sessionTracker: SessionTracker,
    register: <T extends vscode.Disposable>(disposable: T) => T
): void {
    const workspacePath = workspaceFolder.uri.fsPath;

    // onDidSaveTextDocument fires for autosave too (files.autoSave: afterDelay re-saves on every
    // pause while typing, onFocusChange on every tab switch) — neither is a meaningful checkpoint
    // worth logging. Track the reason from onWillSaveTextDocument so onDidSaveTextDocument can
    // skip anything that wasn't an explicit Cmd/Ctrl+S.
    const pendingSaveReasons = new Map<string, vscode.TextDocumentSaveReason>();
    register(vscode.workspace.onWillSaveTextDocument((e) => {
        pendingSaveReasons.set(e.document.uri.toString(), e.reason);
    }));

    register(vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== 'file') { return; }

        const saveReason = pendingSaveReasons.get(document.uri.toString());
        pendingSaveReasons.delete(document.uri.toString());
        if (saveReason !== undefined && saveReason !== vscode.TextDocumentSaveReason.Manual) { return; }

        const filePath = document.uri.fsPath;
        if (!shouldLogFileChange(workspacePath, logDir, filePath)) { return; }

        const relativePath = path.relative(workspacePath, filePath);
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            source: 'file_change',
            session_id: sessionTracker.lastSessionId,
            user_id: resolveUserId(workspaceFolder),
            call_context: { cwd: workspacePath },
            role: 'file_change',
            content: relativePath,
            project_id: getProjectId(workspaceFolder),
        };
        output.appendLine(`[AI Log] File saved: ${relativePath}`);
        const entryCount = isSaveLocallyEnabled(workspaceFolder) ? appendToLog(logDir, entry) : undefined;
        void sendToApi(entry, workspaceFolder, context, output, logDir, entryCount);
    }));
}

function startTerminalWatcher(
    output: vscode.OutputChannel,
    workspaceFolder: vscode.WorkspaceFolder,
    context: vscode.ExtensionContext,
    logDir: string,
    sessionTracker: SessionTracker,
    register: <T extends vscode.Disposable>(disposable: T) => T
): void {
    const workspacePath = workspaceFolder.uri.fsPath;
    const executionOutputs = new WeakMap<vscode.TerminalShellExecution, string[]>();

    register(vscode.window.onDidStartTerminalShellExecution((e) => {
        const chunks: string[] = [];
        executionOutputs.set(e.execution, chunks);
        let collected = 0;

        (async () => {
            try {
                for await (const data of e.execution.read()) {
                    if (collected >= MAX_TERMINAL_OUTPUT_CHARS) { continue; }
                    chunks.push(data);
                    collected += data.length;
                }
            } catch {
                // Stream can end abruptly if the terminal is closed mid-command.
            }
        })();
    }));

    register(vscode.window.onDidEndTerminalShellExecution((e) => {
        const commandLine = e.execution.commandLine.value?.trim();
        if (!commandLine) { return; }

        const chunks = executionOutputs.get(e.execution) ?? [];
        executionOutputs.delete(e.execution);

        const status = classifyExitCode(e.exitCode);
        const entry: LogEntry = {
            timestamp: new Date().toISOString(),
            source: 'terminal',
            session_id: sessionTracker.lastSessionId,
            user_id: resolveUserId(workspaceFolder),
            call_context: { cwd: e.execution.cwd?.fsPath ?? workspacePath },
            role: 'terminal',
            content: buildTerminalContent(commandLine, chunks.join('')),
            exit_code: e.exitCode,
            status,
            project_id: getProjectId(workspaceFolder),
        };
        output.appendLine(`[AI Log] Terminal ${status}: ${commandLine} (exit ${e.exitCode ?? 'unknown'})`);
        const entryCount = isSaveLocallyEnabled(workspaceFolder) ? appendToLog(logDir, entry) : undefined;
        void sendToApi(entry, workspaceFolder, context, output, logDir, entryCount);
    }));
}

export function deactivate(): void {}
