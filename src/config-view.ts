import * as vscode from 'vscode';
import { API_BASE_URL, UserProject, verifyApiKey } from './api-client';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

interface ConfigState {
    enabled: boolean;
    userIdManualCode: string;
    saveLocally: boolean;
    projectId: string;
}

export class ConfigViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cognitrace.configView';

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        webviewView.webview.options = { enableScripts: true };
        this.render(webviewView.webview);
        void this.refreshApiStatus(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message: { type?: string; value?: boolean | string }) => {
            if (message?.type === 'setEnabled') {
                void this.setEnabled(webviewView.webview, Boolean(message.value));
            } else if (message?.type === 'setUserIdManualCode') {
                void this.setUserIdManualCode(webviewView.webview, String(message.value ?? ''));
            } else if (message?.type === 'setSaveLocally') {
                void this.setSaveLocally(webviewView.webview, Boolean(message.value));
            } else if (message?.type === 'setProjectId') {
                void this.setProjectId(webviewView.webview, String(message.value ?? ''));
            }
        });

        // Keep the panel in sync if a setting changes from elsewhere (e.g. settings.json edited
        // directly, or a different window). This posts a lightweight sync message instead of
        // reloading the whole webview, so it never undoes the instant optimistic update from a click.
        const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            if (
                e.affectsConfiguration('cognitrace.enabled', workspaceFolder?.uri) ||
                e.affectsConfiguration('cognitrace.userIdManualCode', workspaceFolder?.uri) ||
                e.affectsConfiguration('cognitrace.saveLocally', workspaceFolder?.uri) ||
                e.affectsConfiguration('cognitrace.projectId', workspaceFolder?.uri)
            ) {
                this.pushSyncState(webviewView.webview, workspaceFolder);
            }
            if (
                e.affectsConfiguration('cognitrace.userIdManualCode', workspaceFolder?.uri) ||
                e.affectsConfiguration('cognitrace.enabled', workspaceFolder?.uri)
            ) {
                void this.refreshApiStatus(webviewView.webview);
            }
        });

        webviewView.onDidDispose(() => {
            configListener.dispose();
        });
    }

    private readState(workspaceFolder: vscode.WorkspaceFolder | undefined): ConfigState {
        const config = vscode.workspace.getConfiguration('cognitrace', workspaceFolder?.uri);
        return {
            enabled: config.get<boolean>('enabled', false),
            userIdManualCode: config.get<string>('userIdManualCode', ''),
            saveLocally: config.get<boolean>('saveLocally', true),
            projectId: config.get<string>('projectId', ''),
        };
    }

    private pushSyncState(webview: vscode.Webview, workspaceFolder: vscode.WorkspaceFolder | undefined): void {
        void webview.postMessage({ type: 'syncState', ...this.readState(workspaceFolder) });
    }

    private async updateConfig(
        webview: vscode.Webview,
        key: 'enabled' | 'userIdManualCode' | 'saveLocally' | 'projectId',
        value: boolean | string,
        resultType: string
    ): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('Cognitrace: open a project folder before configuring logging.');
            void webview.postMessage({ type: resultType, ok: false });
            return;
        }
        try {
            const config = vscode.workspace.getConfiguration('cognitrace', workspaceFolder.uri);
            await config.update(key, value, vscode.ConfigurationTarget.Workspace);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Cognitrace: failed to update setting — ${message}`);
            void webview.postMessage({ type: resultType, ok: false });
            // The optimistic client-side update didn't take — correct it with the real stored state.
            this.pushSyncState(webview, workspaceFolder);
        }
    }

    private async setEnabled(webview: vscode.Webview, value: boolean): Promise<void> {
        await this.updateConfig(webview, 'enabled', value, 'setEnabledResult');
        void this.refreshApiStatus(webview);
    }

    private async setUserIdManualCode(webview: vscode.Webview, value: string): Promise<void> {
        await this.updateConfig(webview, 'userIdManualCode', value, 'setUserIdManualCodeResult');
        void this.refreshApiStatus(webview);
    }

    private async setSaveLocally(webview: vscode.Webview, value: boolean): Promise<void> {
        await this.updateConfig(webview, 'saveLocally', value, 'setSaveLocallyResult');
    }

    private async setProjectId(webview: vscode.Webview, value: string): Promise<void> {
        await this.updateConfig(webview, 'projectId', value, 'setProjectIdResult');
    }

    // Replaces a manual "Test connection" click with an automatic status: re-checked whenever the
    // user code changes (see the caller above and the config listener in resolveWebviewView).
    // Syncing isn't a separate toggle — it's automatic once a code is set, so that's the only
    // thing gating this too.
    private async refreshApiStatus(webview: vscode.Webview): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const config = vscode.workspace.getConfiguration('cognitrace', workspaceFolder?.uri);
        if (!config.get<boolean>('enabled', false)) { return; }

        const userCode = config.get<string>('userIdManualCode', '').trim();

        if (!API_BASE_URL) {
            void webview.postMessage({
                type: 'apiStatus',
                status: 'error',
                error: 'This build has no API URL configured — remote sync is unavailable.',
                projects: [],
            });
            return;
        }
        if (!userCode) {
            void webview.postMessage({
                type: 'apiStatus',
                status: 'error',
                error: 'Set a user code first.',
                projects: [],
            });
            return;
        }

        void webview.postMessage({ type: 'apiStatus', status: 'checking', projects: [] });
        const result = await verifyApiKey(API_BASE_URL, userCode);
        void webview.postMessage(
            result.ok
                ? { type: 'apiStatus', status: 'connected', name: result.name, projects: result.projects }
                : { type: 'apiStatus', status: 'error', error: result.error, projects: [] as UserProject[] }
        );
    }

    private render(webview: vscode.Webview): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        webview.html = this.getHtml(webview, this.readState(workspaceFolder), !!workspaceFolder);
    }

    private getHtml(webview: vscode.Webview, state: ConfigState, hasWorkspace: boolean): string {
        const nonce = getNonce();

        if (!hasWorkspace) {
            return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline';">
<style>${this.baseStyles()}</style>
</head>
<body>
<p>Open a project folder to configure Cognitrace.</p>
</body>
</html>`;
        }

        const escapedCode = state.userIdManualCode.replace(/&/g, '&amp;').replace(/"/g, '&quot;');

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${this.baseStyles()}</style>
</head>
<body>
<div class="row">
<span>Status</span>
<span id="status" class="status"></span>
</div>
<button id="toggle"></button>
<p class="hint">This setting is stored in this workspace's settings and only applies to this project.</p>

<h4>User identification</h4>
<p class="hint">Enter your user code</p>
<input type="text" id="manualCode" placeholder="e.g. dev-1" value="${escapedCode}">

<h4>Project</h4>
<p class="hint">Which of your linked projects this workspace's entries should be tagged with.</p>
<select id="project">
</select>
<p class="hint" id="projectHint"></p>

<h4>Log destination</h4>
<p class="hint">Choose where captured entries go.</p>
<label class="checkbox-option" id="saveLocallyOption">
<input type="checkbox" id="saveLocally">
<span class="checkbox-option-text">
<span class="checkbox-option-title">Save locally</span>
<span class="checkbox-option-desc">Write entries to <code>.ai_log/</code> in this project</span>
</span>
</label>
<div class="row" id="apiStatusRow">
<span>Connection</span>
<span id="apiStatusEl" class="status"></span>
</div>

<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const statusEl = document.getElementById('status');
const buttonEl = document.getElementById('toggle');
const manualCodeEl = document.getElementById('manualCode');
const saveLocallyEl = document.getElementById('saveLocally');
const saveLocallyOptionEl = document.getElementById('saveLocallyOption');
const apiStatusRowEl = document.getElementById('apiStatusRow');
const apiStatusEl = document.getElementById('apiStatusEl');
const projectEl = document.getElementById('project');
const projectHintEl = document.getElementById('projectHint');

let enabled = ${state.enabled};
let saveLocally = ${state.saveLocally};
let projectId = ${JSON.stringify(state.projectId).replace(/</g, '\\u003c')};
let projects = [];

function applyEnabledState() {
    statusEl.textContent = enabled ? 'Enabled' : 'Disabled';
    statusEl.className = 'status ' + (enabled ? 'on' : 'off');
    buttonEl.textContent = enabled ? 'Disable for this project' : 'Enable for this project';
    manualCodeEl.disabled = !enabled;
    saveLocallyEl.disabled = !enabled;
    saveLocallyOptionEl.classList.toggle('disabled', !enabled);
    apiStatusRowEl.hidden = !enabled;
    projectEl.disabled = !enabled || projects.length === 0;
}

function applyApiStatus(status, detail) {
    if (status === 'checking') {
        apiStatusEl.textContent = 'Checking…';
        apiStatusEl.className = 'status';
    } else if (status === 'connected') {
        apiStatusEl.textContent = 'Connected as ' + detail;
        apiStatusEl.className = 'status on';
    } else {
        apiStatusEl.textContent = detail;
        apiStatusEl.className = 'status error';
    }
}

function applyProjects() {
    projectEl.innerHTML = '';
    for (const project of projects) {
        const option = document.createElement('option');
        option.value = project.project_id;
        option.textContent = project.project_name;
        projectEl.appendChild(option);
    }
    if (projects.length > 0 && !projects.some(p => p.project_id === projectId)) {
        projectId = projects[0].project_id;
        vscode.postMessage({ type: 'setProjectId', value: projectId });
    }
    projectEl.value = projects.some(p => p.project_id === projectId) ? projectId : '';
    projectHintEl.textContent = projects.length === 0
        ? 'No projects linked to your code yet — entries will use the auto-detected project.'
        : '';
    projectEl.disabled = !enabled || projects.length === 0;
}

applyEnabledState();
saveLocallyEl.checked = saveLocally;
applyProjects();

buttonEl.addEventListener('click', () => {
    enabled = !enabled;
    applyEnabledState();
    vscode.postMessage({ type: 'setEnabled', value: enabled });
});

saveLocallyEl.addEventListener('change', () => {
    saveLocally = saveLocallyEl.checked;
    vscode.postMessage({ type: 'setSaveLocally', value: saveLocally });
});

manualCodeEl.addEventListener('change', () => {
    vscode.postMessage({ type: 'setUserIdManualCode', value: manualCodeEl.value });
});

projectEl.addEventListener('change', () => {
    projectId = projectEl.value;
    vscode.postMessage({ type: 'setProjectId', value: projectId });
});

window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'setEnabledResult' && !message.ok) {
        enabled = !enabled;
        applyEnabledState();
    } else if (message?.type === 'setProjectIdResult' && !message.ok) {
        projectEl.value = projectId;
    } else if (message?.type === 'apiStatus') {
        applyApiStatus(message.status, message.status === 'connected' ? message.name : message.error);
        if (message.status === 'connected' && Array.isArray(message.projects)) {
            projects = message.projects;
            applyProjects();
        }
    } else if (message?.type === 'syncState') {
        enabled = Boolean(message.enabled);
        if (typeof message.userIdManualCode === 'string') {
            manualCodeEl.value = message.userIdManualCode;
        }
        if (typeof message.saveLocally === 'boolean') {
            saveLocally = message.saveLocally;
        }
        if (typeof message.projectId === 'string') {
            projectId = message.projectId;
            applyProjects();
        }
        applyEnabledState();
        saveLocallyEl.checked = saveLocally;
    }
});
</script>
</body>
</html>`;
    }

    private baseStyles(): string {
        return `
body {
    font-family: var(--vscode-font-family);
    color: var(--vscode-foreground);
    padding: 12px;
}
p { margin: 0 0 12px; line-height: 1.4; }
.row { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
.status { font-weight: 600; }
.status.on { color: var(--vscode-testing-iconPassed, #3fb950); }
.status.off { color: var(--vscode-descriptionForeground); }
.status.error { color: var(--vscode-testing-iconFailed, #f14c4c); }
button {
    width: 100%;
    padding: 6px 10px;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
}
button:hover { background: var(--vscode-button-hoverBackground); }
button:disabled { opacity: 0.5; cursor: default; }
.hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin: 4px 0 12px; }
h4 { margin: 16px 0 4px; font-size: 1em; }
.checkbox-option {
    display: flex;
    align-items: flex-start;
    gap: 6px;
    margin-bottom: 8px;
    cursor: pointer;
}
.checkbox-option input { margin: 3px 0 0; cursor: pointer; flex-shrink: 0; }
.checkbox-option.disabled { cursor: default; opacity: 0.5; }
.checkbox-option.disabled input:disabled { opacity: 1; }
.checkbox-option-text { display: flex; flex-direction: column; }
.checkbox-option-title { font-size: 1em; }
.checkbox-option-desc { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 1px; }
input[type="text"], select {
    width: 100%;
    box-sizing: border-box;
    margin: 0 0 10px;
    padding: 4px 6px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
}
input:disabled, select:disabled { opacity: 0.5; }`;
    }
}
