import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
    timestamp: string;
    source: 'claude' | 'github_copilot' | 'codex' | 'antigravity';
    git_branch: string;
    git_user_name: string;
    call_context: { cwd: string };
    role: 'user' | 'assistant';
    content: string;
}

export type LogSource = LogEntry['source'];

export interface ClaudeTranscriptMessage {
    type: string;
    message?: {
        role: string;
        content: string | Array<{ type: string; text?: string; thinking?: string }>;
    };
}

export interface ParsedLogMessage {
    role: 'user' | 'assistant';
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
        if (!text) { return []; }
        const timestamp = typeof msg.timestamp === 'string' ? msg.timestamp : undefined;
        return [{ role: msg.type, content: text, timestamp }];
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

export function buildLogFilePath(logDir: string, entry: Pick<LogEntry, 'timestamp' | 'git_user_name'>): string {
    const datePart = entry.timestamp.slice(0, 10);
    const userPart = entry.git_user_name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'unknown';
    return path.join(logDir, `prompt_log_${datePart}_${userPart}.json`);
}

export function appendToLog(logDir: string, entry: LogEntry): void {
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
}

export function computeProjectKey(workspacePath: string): string {
    return workspacePath.replace(/[^a-zA-Z0-9]/g, '-');
}
