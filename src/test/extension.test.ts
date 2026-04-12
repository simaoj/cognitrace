import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
    stripContextTags,
    extractClaudeText,
    extractLogMessage,
    appendToLog,
    buildLogFilePath,
    computeProjectKey,
    LogEntry,
} from '../log-utils';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'cognitrace-test-'));
}

function baseEntry(overrides: Partial<LogEntry> = {}): LogEntry {
    return {
        timestamp: '2025-04-12T10:00:00.000Z',
        source: 'claude',
        git_branch: 'main',
        git_user_name: 'Jane Doe',
        call_context: { cwd: '/workspace' },
        role: 'user',
        content: 'hello',
        ...overrides,
    };
}

// ---------------------------------------------------------------------------
// stripContextTags
// ---------------------------------------------------------------------------

suite('stripContextTags', () => {
    test('removes a single tag block', () => {
        const input = '<system_reminder>ignore this</system_reminder>\nreal content';
        assert.strictEqual(stripContextTags(input), 'real content');
    });

    test('removes multiple tag blocks', () => {
        const input = '<foo>a</foo>\n<bar>b</bar>\nkept';
        assert.strictEqual(stripContextTags(input), 'kept');
    });

    test('leaves text without tags unchanged', () => {
        assert.strictEqual(stripContextTags('plain text'), 'plain text');
    });

    test('trims surrounding whitespace', () => {
        assert.strictEqual(stripContextTags('  hello  '), 'hello');
    });

    test('handles multiline tag content', () => {
        const input = '<ctx>line1\nline2\nline3</ctx>\nafter';
        assert.strictEqual(stripContextTags(input), 'after');
    });
});

// ---------------------------------------------------------------------------
// extractClaudeText
// ---------------------------------------------------------------------------

suite('extractClaudeText', () => {
    test('extracts plain string content from user message', () => {
        const msg = { type: 'user', message: { role: 'user', content: 'what is 2+2?' } };
        assert.strictEqual(extractClaudeText(msg), 'what is 2+2?');
    });

    test('extracts text blocks from array content', () => {
        const msg = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'The answer is 4.' },
                ],
            },
        };
        assert.strictEqual(extractClaudeText(msg), 'The answer is 4.');
    });

    test('ignores thinking blocks', () => {
        const msg = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'thinking', thinking: 'internal reasoning' },
                    { type: 'text', text: 'visible reply' },
                ],
            },
        };
        assert.strictEqual(extractClaudeText(msg), 'visible reply');
    });

    test('strips context tags from user messages', () => {
        const msg = {
            type: 'user',
            message: {
                role: 'user',
                content: [
                    { type: 'text', text: '<system_context>hidden</system_context>\nactual prompt' },
                ],
            },
        };
        assert.strictEqual(extractClaudeText(msg), 'actual prompt');
    });

    test('does NOT strip tags from assistant messages', () => {
        const msg = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: '<foo>kept</foo>',
            },
        };
        assert.strictEqual(extractClaudeText(msg), '<foo>kept</foo>');
    });

    test('returns empty string when content is missing', () => {
        const msg = { type: 'user', message: { role: 'user', content: '' } };
        assert.strictEqual(extractClaudeText(msg), '');
    });

    test('returns empty string when message is undefined', () => {
        const msg = { type: 'user' };
        assert.strictEqual(extractClaudeText(msg), '');
    });

    test('joins multiple text blocks with newline', () => {
        const msg = {
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [
                    { type: 'text', text: 'part one' },
                    { type: 'text', text: 'part two' },
                ],
            },
        };
        assert.strictEqual(extractClaudeText(msg), 'part one\npart two');
    });
});

// ---------------------------------------------------------------------------
// extractLogMessage — claude
// ---------------------------------------------------------------------------

suite('extractLogMessage (claude)', () => {
    test('parses a user message', () => {
        const line = JSON.stringify({
            type: 'user',
            message: { role: 'user', content: 'fix the bug' },
        });
        const result = extractLogMessage(line, 'claude');
        assert.deepStrictEqual(result, { role: 'user', content: 'fix the bug' });
    });

    test('parses an assistant message', () => {
        const line = JSON.stringify({
            type: 'assistant',
            message: {
                role: 'assistant',
                content: [{ type: 'text', text: 'done' }],
            },
        });
        const result = extractLogMessage(line, 'claude');
        assert.deepStrictEqual(result, { role: 'assistant', content: 'done' });
    });

    test('returns null for irrelevant types (queue-operation)', () => {
        const line = JSON.stringify({ type: 'queue-operation' });
        assert.strictEqual(extractLogMessage(line, 'claude'), null);
    });

    test('returns null for empty assistant text', () => {
        const line = JSON.stringify({
            type: 'assistant',
            message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'only thinking' }] },
        });
        assert.strictEqual(extractLogMessage(line, 'claude'), null);
    });

    test('returns null for invalid JSON', () => {
        assert.strictEqual(extractLogMessage('{bad json', 'claude'), null);
    });
});

// ---------------------------------------------------------------------------
// extractLogMessage — github_copilot
// ---------------------------------------------------------------------------

suite('extractLogMessage (github_copilot)', () => {
    test('parses a user input message', () => {
        const line = JSON.stringify({ kind: 1, k: ['inputState', 'inputText'], v: 'explain this code' });
        const result = extractLogMessage(line, 'github_copilot');
        assert.deepStrictEqual(result, { role: 'user', content: 'explain this code' });
    });

    test('returns null when user input text is empty', () => {
        const line = JSON.stringify({ kind: 1, k: ['inputState', 'inputText'], v: '   ' });
        assert.strictEqual(extractLogMessage(line, 'github_copilot'), null);
    });

    test('parses an assistant response with visible parts', () => {
        const line = JSON.stringify({
            kind: 2,
            k: ['requests'],
            v: [{
                response: [
                    { value: 'Here is the explanation.', supportThemeIcons: true },
                ],
            }],
        });
        const result = extractLogMessage(line, 'github_copilot');
        assert.deepStrictEqual(result, { role: 'assistant', content: 'Here is the explanation.' });
    });

    test('returns null for assistant response without visible parts', () => {
        const line = JSON.stringify({
            kind: 2,
            k: ['requests'],
            v: [{ response: [{ value: 'hidden' }] }],
        });
        assert.strictEqual(extractLogMessage(line, 'github_copilot'), null);
    });

    test('returns null for unrecognised kind', () => {
        const line = JSON.stringify({ kind: 99, k: ['other'] });
        assert.strictEqual(extractLogMessage(line, 'github_copilot'), null);
    });
});

// ---------------------------------------------------------------------------
// extractLogMessage — codex
// ---------------------------------------------------------------------------

suite('extractLogMessage (codex)', () => {
    test('parses a user message', () => {
        const line = JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: 'refactor this' },
        });
        const result = extractLogMessage(line, 'codex');
        assert.deepStrictEqual(result, { role: 'user', content: 'refactor this' });
    });

    test('parses an assistant response', () => {
        const line = JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'output_text', text: 'here you go' }],
            },
        });
        const result = extractLogMessage(line, 'codex');
        assert.deepStrictEqual(result, { role: 'assistant', content: 'here you go' });
    });

    test('returns null when assistant content has no output_text', () => {
        const line = JSON.stringify({
            type: 'response_item',
            payload: {
                type: 'message',
                role: 'assistant',
                content: [{ type: 'tool_call', text: 'ignored' }],
            },
        });
        assert.strictEqual(extractLogMessage(line, 'codex'), null);
    });

    test('returns null for empty user message', () => {
        const line = JSON.stringify({
            type: 'event_msg',
            payload: { type: 'user_message', message: '' },
        });
        assert.strictEqual(extractLogMessage(line, 'codex'), null);
    });
});

// ---------------------------------------------------------------------------
// computeProjectKey
// ---------------------------------------------------------------------------

suite('computeProjectKey', () => {
    test('replaces slashes with hyphens', () => {
        assert.strictEqual(
            computeProjectKey('/Users/jane/code/my-app'),
            '-Users-jane-code-my-app'
        );
    });

    test('replaces dots with hyphens (e.g. github.io)', () => {
        assert.strictEqual(
            computeProjectKey('/Users/jane/code/simaoj.github.io'),
            '-Users-jane-code-simaoj-github-io'
        );
    });

    test('preserves alphanumeric characters', () => {
        assert.match(computeProjectKey('/a/b/c123'), /^[a-zA-Z0-9-]+$/);
    });
});

// ---------------------------------------------------------------------------
// buildLogFilePath
// ---------------------------------------------------------------------------

suite('buildLogFilePath', () => {
    test('uses date part from timestamp', () => {
        const p = buildLogFilePath('/log', { timestamp: '2025-04-12T10:00:00.000Z', git_user_name: 'alice' });
        assert.ok(p.includes('2025-04-12'));
    });

    test('slugifies git_user_name', () => {
        const p = buildLogFilePath('/log', { timestamp: '2025-04-12T10:00:00.000Z', git_user_name: 'Jane Doe' });
        assert.ok(p.includes('jane-doe'));
    });

    test('falls back to "unknown" for empty user name', () => {
        const p = buildLogFilePath('/log', { timestamp: '2025-04-12T10:00:00.000Z', git_user_name: '' });
        assert.ok(path.basename(p).includes('unknown'));
    });
});

// ---------------------------------------------------------------------------
// appendToLog
// ---------------------------------------------------------------------------

suite('appendToLog', () => {
    let tmpDir: string;

    setup(() => { tmpDir = makeTmpDir(); });
    teardown(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

    test('creates the log directory and file if they do not exist', () => {
        const logDir = path.join(tmpDir, 'sub', '.ai_log');
        appendToLog(logDir, baseEntry());
        assert.ok(fs.existsSync(logDir));
    });

    test('writes a valid JSON array with one entry', () => {
        appendToLog(tmpDir, baseEntry({ content: 'first' }));
        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
        assert.strictEqual(files.length, 1);
        const entries = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].content, 'first');
    });

    test('appends to an existing file', () => {
        const stamp = '2025-04-12T10:00:00.000Z';
        appendToLog(tmpDir, baseEntry({ timestamp: stamp, content: 'first' }));
        appendToLog(tmpDir, baseEntry({ timestamp: stamp, content: 'second' }));
        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
        const entries = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
        assert.strictEqual(entries.length, 2);
        assert.strictEqual(entries[1].content, 'second');
    });

    test('creates separate files for different dates', () => {
        appendToLog(tmpDir, baseEntry({ timestamp: '2025-04-12T10:00:00.000Z' }));
        appendToLog(tmpDir, baseEntry({ timestamp: '2025-04-13T10:00:00.000Z' }));
        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
        assert.strictEqual(files.length, 2);
    });

    test('recovers gracefully from a corrupt log file', () => {
        const logPath = buildLogFilePath(tmpDir, baseEntry());
        fs.mkdirSync(tmpDir, { recursive: true });
        fs.writeFileSync(logPath, 'NOT VALID JSON', 'utf8');
        assert.doesNotThrow(() => appendToLog(tmpDir, baseEntry({ content: 'recovery' })));
        const entries = JSON.parse(fs.readFileSync(logPath, 'utf8'));
        assert.strictEqual(entries.length, 1);
        assert.strictEqual(entries[0].content, 'recovery');
    });

    test('preserves all LogEntry fields', () => {
        const entry = baseEntry({ source: 'codex', role: 'assistant', content: 'full entry' });
        appendToLog(tmpDir, entry);
        const files = fs.readdirSync(tmpDir).filter(f => f.endsWith('.json'));
        const [saved] = JSON.parse(fs.readFileSync(path.join(tmpDir, files[0]), 'utf8'));
        assert.strictEqual(saved.source, 'codex');
        assert.strictEqual(saved.role, 'assistant');
        assert.strictEqual(saved.content, 'full entry');
        assert.strictEqual(saved.git_branch, 'main');
    });
});
