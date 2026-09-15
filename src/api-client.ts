import { LogEntry } from './log-utils';

// Baked in at build time (see webpack.config.js's DefinePlugin) from whichever environment ran
// the build — so a packaged extension already knows where to send logs, and nobody using it has
// to configure a URL themselves. Empty when a build didn't set COGNITRACE_API_URL, in which case
// remote sync just never fires.
export const API_BASE_URL: string = (process.env.COGNITRACE_API_URL ?? '').trim();

export interface ApiConfig {
    apiUrl: string;
    apiKey: string;
}

function normalizeApiUrl(apiUrl: string): string {
    return apiUrl.replace(/\/+$/, '');
}

export async function postLogEntry(config: ApiConfig, entry: LogEntry): Promise<void> {
    const response = await fetch(`${normalizeApiUrl(config.apiUrl)}/api/logs`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'X-API-Key': config.apiKey,
        },
        body: JSON.stringify(entry),
    });

    if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new Error(`API responded with ${response.status}${body ? `: ${body}` : ''}`);
    }
}

export interface UserProject {
    project_id: string;
    project_name: string;
}

export type VerifyApiKeyResult =
    | { ok: true; name: string; projects: UserProject[] }
    | { ok: false; error: string };

export async function verifyApiKey(apiUrl: string, apiKey: string): Promise<VerifyApiKeyResult> {
    try {
        const response = await fetch(`${normalizeApiUrl(apiUrl)}/api/users/me`, {
            headers: { 'X-API-Key': apiKey },
        });

        if (!response.ok) {
            return { ok: false, error: response.status === 401 ? 'Invalid API key' : `HTTP ${response.status}` };
        }

        const data = (await response.json()) as {
            student_number?: string | number;
            projects?: Array<{ project_id: string; project_name: string }>;
        };
        const projects = Array.isArray(data.projects)
            ? data.projects.map(p => ({ project_id: p.project_id, project_name: p.project_name }))
            : [];
        return {
            ok: true,
            name: data.student_number !== undefined ? String(data.student_number) : 'unknown',
            projects,
        };
    } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
}
