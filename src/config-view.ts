import * as vscode from 'vscode';

function getNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let text = '';
    for (let i = 0; i < 32; i++) {
        text += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return text;
}

export class ConfigViewProvider implements vscode.WebviewViewProvider {
    public static readonly viewType = 'cognitrace.configView';

    resolveWebviewView(webviewView: vscode.WebviewView): void {
        webviewView.webview.options = { enableScripts: true };
        this.render(webviewView.webview);

        webviewView.webview.onDidReceiveMessage((message: { type?: string; value?: boolean }) => {
            if (message?.type === 'setEnabled') {
                void this.setEnabled(webviewView.webview, Boolean(message.value));
            }
        });

        // Keep the panel in sync if the setting changes from elsewhere (e.g. settings.json edited
        // directly, or a different window). This posts a lightweight sync message instead of
        // reloading the whole webview, so it never undoes the instant optimistic update from a click.
        const configListener = vscode.workspace.onDidChangeConfiguration((e) => {
            if (e.affectsConfiguration('cognitrace.enabled')) {
                const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
                const enabled = vscode.workspace
                    .getConfiguration('cognitrace', workspaceFolder?.uri)
                    .get<boolean>('enabled', false);
                void webviewView.webview.postMessage({ type: 'syncState', enabled });
            }
        });
        webviewView.onDidDispose(() => configListener.dispose());
    }

    private async setEnabled(webview: vscode.Webview, value: boolean): Promise<void> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
            vscode.window.showErrorMessage('Cognitrace: open a project folder before enabling logging.');
            void webview.postMessage({ type: 'setEnabledResult', ok: false });
            return;
        }
        try {
            const config = vscode.workspace.getConfiguration('cognitrace', workspaceFolder.uri);
            await config.update('enabled', value, vscode.ConfigurationTarget.Workspace);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(`Cognitrace: failed to update setting — ${message}`);
            void webview.postMessage({ type: 'setEnabledResult', ok: false });
        }
    }

    private render(webview: vscode.Webview): void {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const enabled = vscode.workspace
            .getConfiguration('cognitrace', workspaceFolder?.uri)
            .get<boolean>('enabled', false);
        webview.html = this.getHtml(webview, enabled, !!workspaceFolder);
    }

    private getHtml(webview: vscode.Webview, enabled: boolean, hasWorkspace: boolean): string {
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

        return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
<style>${this.baseStyles()}</style>
</head>
<body>
<p>Cognitrace logs prompts and responses from AI assistants into <code>.ai_log/</code> at the root of this project.</p>
<div class="row">
<span>Status</span>
<span id="status" class="status"></span>
</div>
<button id="toggle"></button>
<p class="hint">This setting is stored in this workspace's settings and only applies to this project.</p>
<script nonce="${nonce}">
const vscode = acquireVsCodeApi();
const statusEl = document.getElementById('status');
const buttonEl = document.getElementById('toggle');
let enabled = ${enabled};

function applyState() {
    statusEl.textContent = enabled ? 'Enabled' : 'Disabled';
    statusEl.className = 'status ' + (enabled ? 'on' : 'off');
    buttonEl.textContent = enabled ? 'Disable for this project' : 'Enable for this project';
}
applyState();

buttonEl.addEventListener('click', () => {
    enabled = !enabled;
    applyState();
    vscode.postMessage({ type: 'setEnabled', value: enabled });
});

window.addEventListener('message', (event) => {
    const message = event.data;
    if (message?.type === 'setEnabledResult' && !message.ok) {
        enabled = !enabled;
        applyState();
    } else if (message?.type === 'syncState') {
        enabled = Boolean(message.enabled);
        applyState();
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
.hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 12px; }`;
    }
}
