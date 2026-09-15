import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
    timestamp: string;
    source: 'claude' | 'github_copilot' | 'codex' | 'antigravity' | 'terminal' | 'file_change';
    session_id?: string;
    user_id: string;
    call_context: { cwd: string };
    role: 'user' | 'assistant' | 'terminal' | 'file_change' | 'context_file';
    content: string;
    exit_code?: number;
    status?: TerminalStatus;
    project_id?: string;
}

export type LogSource = LogEntry['source'];

export interface ClaudeTranscriptMessage {
    type: string;
    message?: {
        role: string;
        content: string | Array<{ type: string; text?: string; thinking?: string; name?: string; input?: any }>;
    };
    toolUseResult?: {
        questions?: Array<{ question: string }>;
        answers?: Record<string, string>;
    };
}

export interface ParsedLogMessage {
    role: 'user' | 'assistant' | 'context_file';
    content: string;
    timestamp?: string;
}

export function stripContextTags(text: string): string {
    return text.replace(/<[a-z_]+>[\s\S]*?<\/[a-z_]+>\n?/g, '').trim();
}

export function extractClaudeText(msg: ClaudeTranscriptMessage): string {
    const content = msg.message?.content;
    if (!content) { return ''; }

    let raw = '';
    if (typeof content === 'string') {
        raw = content;
    } else if (Array.isArray(content)) {
        raw = content
            .filter(c => c.type === 'text')
            .map(c => c.text ?? '')
            .join('\n');
    }

    return msg.type === 'user' ? stripContextTags(raw) : raw.trim();
}

function formatAskUserQuestions(questions: Array<{ question: string; options?: Array<{ label: string }> }>): string {
    return questions
        .map(q => {
            const options = (q.options ?? []).map(o => o.label).filter(Boolean).join(' | ');
            return options ? `${q.question}\nOptions: ${options}` : q.question;
        })
        .join('\n\n');
}

export function extractClaudeInteractiveText(msg: ClaudeTranscriptMessage): string {
    if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (!Array.isArray(content)) { return ''; }

        const prompts = content
            .filter(c => c.type === 'tool_use' && c.name === 'AskUserQuestion')
            .map(c => formatAskUserQuestions(c.input?.questions ?? []))
            .filter(Boolean);

        return prompts.join('\n\n');
    }

    if (msg.type === 'user') {
        const answers = msg.toolUseResult?.answers;
        if (!answers) { return ''; }

        const questions = msg.toolUseResult?.questions ?? [];
        const pairs = questions.length
            ? questions.map(q => `${q.question} → ${answers[q.question] ?? ''}`)
            : Object.entries(answers).map(([question, answer]) => `${question} → ${answer}`);

        return pairs.filter(Boolean).join('\n');
    }

    return '';
}

const IDE_OPENED_FILE_PATTERN = /The user opened the file (\S+) in the IDE/;
const IDE_SELECTION_PATTERN = /The user selected the lines \d+ to \d+ from ([^\n:]+):/;

export function extractClaudeContextFiles(msg: ClaudeTranscriptMessage): string[] {
    if (msg.type === 'assistant') {
        const content = msg.message?.content;
        if (!Array.isArray(content)) { return []; }

        return content
            .filter(c => c.type === 'tool_use' && c.name === 'Read' && typeof c.input?.file_path === 'string')
            .map(c => c.input.file_path as string);
    }

    if (msg.type === 'user') {
        const content = msg.message?.content;
        let raw = '';
        if (typeof content === 'string') {
            raw = content;
        } else if (Array.isArray(content)) {
            raw = content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
        }
        if (!raw) { return []; }

        const files: string[] = [];
        const openedMatch = raw.match(IDE_OPENED_FILE_PATTERN);
        if (openedMatch) { files.push(openedMatch[1]); }

        const selectionMatch = raw.match(IDE_SELECTION_PATTERN);
        if (selectionMatch) { files.push(selectionMatch[1]); }

        return files;
    }

    return [];
}

function extractCopilotUserText(request: any): string {
    const candidates = [
        request?.renderedUserMessage,
        request?.message?.text,
        request?.message?.content,
        request?.text,
        request?.content,
        request?.message,
    ];

    for (const candidate of candidates) {
        const text = extractCopilotText(candidate);
        if (text) { return text; }
    }

    return '';
}

function extractCopilotAssistantText(request: any): string {
    const rendered = extractCopilotText(request?.renderedAssistantMessage);
    if (rendered) { return rendered; }

    const response = request?.response;
    if (!response) { return ''; }

    if (!Array.isArray(response)) {
        return extractCopilotText(response);
    }

    const visibleParts: string[] = [];
    for (const item of response) {
        const text = extractCopilotText(item?.value ?? item?.text ?? item?.content ?? item);
        if (!text) { continue; }

        if ('supportThemeIcons' in item || 'supportHtml' in item || 'baseUri' in item) {
            visibleParts.push(text);
        }
    }

    return visibleParts.join('\n');
}

function extractCopilotText(value: any): string {
    if (typeof value === 'string') {
        return value.trim();
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const text = extractCopilotText(item);
            if (text) { return text; }
        }
        return '';
    }

    if (!value || typeof value !== 'object') {
        return '';
    }

    const prioritizedKeys = ['text', 'content', 'value', 'message', 'renderedText', 'renderedMessage'];
    for (const key of prioritizedKeys) {
        const text = extractCopilotText(value[key]);
        if (text) { return text; }
    }

    for (const candidate of Object.values(value)) {
        const text = extractCopilotText(candidate);
        if (text) { return text; }
    }

    return '';
}

function extractTimestamp(value: any): string | undefined {
    if (!value) { return undefined; }

    if (typeof value === 'string' || typeof value === 'number') {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }

    if (typeof value !== 'object') {
        return undefined;
    }

    const candidateKeys = ['timestamp', 'time', 'createdAt', 'created_at', 'date'];
    for (const key of candidateKeys) {
        const nested = extractTimestamp(value[key]);
        if (nested) { return nested; }
    }

    return undefined;
}

function getCopilotRequests(msg: any): any[] {
    if (Array.isArray(msg?.v)) { return msg.v; }
    if (Array.isArray(msg?.v?.requests)) { return msg.v.requests; }
    if (Array.isArray(msg?.requests)) { return msg.requests; }
    const wrapperKeys = ['v', 'value', 'data', 'payload'];
    for (const key of wrapperKeys) {
        const nested = msg?.[key];
        if (!nested || typeof nested !== 'object') { continue; }
        const requests = getCopilotRequests(nested);
        if (requests.length) { return requests; }
    }
    if (msg?.v && typeof msg.v === 'object') { return [msg.v]; }
    return [];
}

export function extractLogMessages(
    rawLine: string,
    source: LogSource
): ParsedLogMessage[] {
    let msg: any;
    try {
        msg = JSON.parse(rawLine);
    } catch {
        return [];
    }

    if (source === 'claude') {
        if (msg.type !== 'user' && msg.type !== 'assistant') { return []; }
        const text = extractClaudeText(msg as ClaudeTranscriptMessage);
        const interactiveText = extractClaudeInteractiveText(msg as ClaudeTranscriptMessage);
        const content = [text, interactiveText].filter(Boolean).join('\n\n');
        const timestamp = typeof msg.timestamp === 'string' ? msg.timestamp : undefined;

        const messages: ParsedLogMessage[] = [];
        if (content) {
            messages.push({ role: msg.type, content, timestamp });
        }
        for (const file of extractClaudeContextFiles(msg as ClaudeTranscriptMessage)) {
            messages.push({ role: 'context_file', content: file, timestamp });
        }
        return messages;
    }

    if (source === 'github_copilot') {
        if (msg.kind === 1 && Array.isArray(msg.k) && msg.k[0] === 'inputState' && msg.k[1] === 'inputText') {
            const text = typeof msg.v === 'string' ? msg.v.trim() : '';
            if (!text) { return []; }
            return [{ role: 'user', content: text }];
        }

        if (msg.kind === 2 && Array.isArray(msg.k) && msg.k[0] === 'requests') {
            const requests = getCopilotRequests(msg);
            const messages: ParsedLogMessage[] = [];
            const fallbackTimestamp = extractTimestamp(msg) ?? extractTimestamp(msg.v);

            for (const request of requests) {
                const timestamp = extractTimestamp(request) ?? fallbackTimestamp;
                const userText = extractCopilotUserText(request);
                if (userText) {
                    messages.push({ role: 'user', content: userText, timestamp });
                }

                const assistantText = extractCopilotAssistantText(request);
                if (assistantText) {
                    messages.push({ role: 'assistant', content: assistantText, timestamp });
                }
            }

            return messages;
        }

        return [];
    }

    if (source === 'codex') {
        const timestamp = typeof msg.timestamp === 'string' ? msg.timestamp : undefined;

        if (msg.type === 'event_msg' && msg.payload?.type === 'user_message') {
            const text = typeof msg.payload?.message === 'string' ? msg.payload.message.trim() : '';
            if (!text) { return []; }
            return [{ role: 'user', content: text, timestamp }];
        }

        if (msg.type === 'response_item' && msg.payload?.type === 'message' && msg.payload?.role === 'assistant') {
            const content = Array.isArray(msg.payload?.content) ? msg.payload.content : [];
            const visibleParts = content
                .filter((item: any) => item?.type === 'output_text')
                .map((item: any) => typeof item?.text === 'string' ? item.text.trim() : '')
                .filter(Boolean);

            if (!visibleParts.length) { return []; }
            return [{ role: 'assistant', content: visibleParts.join('\n'), timestamp }];
        }

        return [];
    }

    if (source === 'antigravity') {
        const timestamp = extractTimestamp(msg);
        if (msg.source === 'USER_EXPLICIT' && msg.type === 'USER_INPUT' && typeof msg.content === 'string') {
            const match = msg.content.match(/<USER_REQUEST>([\s\S]*?)<\/USER_REQUEST>/);
            if (match && match[1].trim()) {
                return [{ role: 'user', content: match[1].trim(), timestamp }];
            }
            if (msg.content.trim()) {
                return [{ role: 'user', content: msg.content.trim(), timestamp }];
            }
        }
        if (msg.source === 'MODEL' && typeof msg.content === 'string' && msg.content.trim()) {
            return [{ role: 'assistant', content: msg.content.trim(), timestamp }];
        }
        return [];
    }

    return [];
}

export function extractLogMessage(
    rawLine: string,
    source: LogSource
): ParsedLogMessage | null {
    return extractLogMessages(rawLine, source)[0] ?? null;
}

export function buildLogFilePath(logDir: string, entry: Pick<LogEntry, 'timestamp' | 'user_id'>): string {
    const datePart = entry.timestamp.slice(0, 10);
    const userPart = entry.user_id
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
    return path.join(logDir, `prompt_log_${datePart}_${userPart}.json`);
}

// Returns the entry's 1-based position in its log file (i.e. the file's new entry count),
// so callers can track how many entries of a given file have been synced elsewhere.
export function appendToLog(logDir: string, entry: LogEntry): number {
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = buildLogFilePath(logDir, entry);
    let entries: LogEntry[] = [];
    if (fs.existsSync(logPath)) {
        try {
            entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        } catch { /* start fresh if corrupt */ }
    }
    entries.push(entry);
    fs.writeFileSync(logPath, JSON.stringify(entries, null, 2), 'utf8');
    return entries.length;
}

export function computeProjectKey(workspacePath: string): string {
    return workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
}

const CODEX_ROLLOUT_FILENAME_PATTERN = /^rollout-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-(.+)$/;

export function deriveSessionId(filePath: string, source: LogSource): string {
    const base = path.basename(filePath, path.extname(filePath));
    if (source === 'codex') {
        const match = base.match(CODEX_ROLLOUT_FILENAME_PATTERN);
        if (match) { return match[1]; }
    }
    return base;
}

export type TerminalStatus = 'success' | 'error' | 'unknown';

export function classifyExitCode(exitCode: number | undefined): TerminalStatus {
    if (exitCode === undefined) { return 'unknown'; }
    return exitCode === 0 ? 'success' : 'error';
}

const ANSI_PATTERN = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07]*\x07|\x1b[()][0-9A-Za-z]|\x1b[=>]/g;

export function stripAnsiCodes(text: string): string {
    return text.replace(ANSI_PATTERN, '');
}

export const MAX_TERMINAL_OUTPUT_CHARS = 4000;

export function truncateOutput(text: string, max = MAX_TERMINAL_OUTPUT_CHARS): string {
    if (text.length <= max) { return text; }
    return `${text.slice(0, max)}\n...[truncated]`;
}

export function buildTerminalContent(commandLine: string, outputText: string): string {
    const trimmedOutput = truncateOutput(stripAnsiCodes(outputText)).trim();
    return trimmedOutput ? `$ ${commandLine}\n${trimmedOutput}` : `$ ${commandLine}`;
}

function isInside(parentDir: string, targetPath: string): boolean {
    const rel = path.relative(parentDir, targetPath);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

export function shouldLogFileChange(workspacePath: string, logDir: string, filePath: string): boolean {
    if (!isInside(workspacePath, filePath)) { return false; }
    if (isInside(logDir, filePath)) { return false; }
    return true;
}
