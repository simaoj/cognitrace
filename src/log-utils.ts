import * as fs from 'fs';
import * as path from 'path';

export interface LogEntry {
    timestamp: string;
    source: 'claude' | 'github_copilot' | 'codex';
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

export function extractLogMessage(
    rawLine: string,
    source: LogSource
): { role: 'user' | 'assistant'; content: string } | null {
    let msg: any;
    try {
        msg = JSON.parse(rawLine);
    } catch {
        return null;
    }

    if (source === 'claude') {
        if (msg.type !== 'user' && msg.type !== 'assistant') { return null; }
        const text = extractClaudeText(msg as ClaudeTranscriptMessage);
        if (!text) { return null; }
        return { role: msg.type, content: text };
    }

    if (source === 'github_copilot') {
        if (msg.kind === 1 && Array.isArray(msg.k) && msg.k[0] === 'inputState' && msg.k[1] === 'inputText') {
            const text = typeof msg.v === 'string' ? msg.v.trim() : '';
            if (!text) { return null; }
            return { role: 'user', content: text };
        }

        if (msg.kind === 2 && Array.isArray(msg.k) && msg.k[0] === 'requests') {
            const requests = Array.isArray(msg.v) ? msg.v : [];
            const visibleParts: string[] = [];

            for (const request of requests) {
                const response = request?.response;
                if (!Array.isArray(response)) { continue; }

                for (const item of response) {
                    const text = typeof item?.value === 'string' ? item.value.trim() : '';
                    if (!text) { continue; }

                    if ('supportThemeIcons' in item || 'supportHtml' in item || 'baseUri' in item) {
                        visibleParts.push(text);
                    }
                }
            }

            if (!visibleParts.length) { return null; }
            return { role: 'assistant', content: visibleParts.join('\n') };
        }

        return null;
    }

    if (source === 'codex') {
        if (msg.type === 'event_msg' && msg.payload?.type === 'user_message') {
            const text = typeof msg.payload?.message === 'string' ? msg.payload.message.trim() : '';
            if (!text) { return null; }
            return { role: 'user', content: text };
        }

        if (msg.type === 'response_item' && msg.payload?.type === 'message' && msg.payload?.role === 'assistant') {
            const content = Array.isArray(msg.payload?.content) ? msg.payload.content : [];
            const visibleParts = content
                .filter((item: any) => item?.type === 'output_text')
                .map((item: any) => typeof item?.text === 'string' ? item.text.trim() : '')
                .filter(Boolean);

            if (!visibleParts.length) { return null; }
            return { role: 'assistant', content: visibleParts.join('\n') };
        }

        return null;
    }

    return null;
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
