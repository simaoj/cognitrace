import * as assert from 'assert';
import { postLogEntry, verifyApiKey } from '../api-client';
import { LogEntry } from '../log-utils';

function baseEntry(): LogEntry {
    return {
        timestamp: '2025-04-12T10:00:00.000Z',
        source: 'claude',
        user_id: 'Jane Doe',
        call_context: { cwd: '/workspace' },
        role: 'user',
        content: 'hello',
    };
}

type FetchArgs = [url: string, init?: RequestInit];

function stubFetch(handler: (...args: FetchArgs) => Promise<Response> | Response): FetchArgs[] {
    const calls: FetchArgs[] = [];
    (globalThis as { fetch: typeof fetch }).fetch = (async (...args: FetchArgs) => {
        calls.push(args);
        return handler(...args);
    }) as typeof fetch;
    return calls;
}

suite('postLogEntry', () => {
    const originalFetch = globalThis.fetch;
    teardown(() => { globalThis.fetch = originalFetch; });

    test('posts to /api/logs with the API key header and JSON body', async () => {
        const calls = stubFetch(() => new Response(null, { status: 200 }));

        await postLogEntry({ apiUrl: 'http://localhost:8000', apiKey: 'cgt_abc' }, baseEntry());

        assert.strictEqual(calls.length, 1);
        const [url, init] = calls[0];
        assert.strictEqual(url, 'http://localhost:8000/api/logs');
        assert.strictEqual(init?.method, 'POST');
        assert.strictEqual((init?.headers as Record<string, string>)['X-API-Key'], 'cgt_abc');
        assert.deepStrictEqual(JSON.parse(init?.body as string), baseEntry());
    });

    test('strips a trailing slash from the configured API URL', async () => {
        const calls = stubFetch(() => new Response(null, { status: 200 }));

        await postLogEntry({ apiUrl: 'http://localhost:8000/', apiKey: 'cgt_abc' }, baseEntry());

        assert.strictEqual(calls[0][0], 'http://localhost:8000/api/logs');
    });

    test('throws when the API responds with an error status', async () => {
        stubFetch(() => new Response('bad request', { status: 400 }));

        await assert.rejects(
            () => postLogEntry({ apiUrl: 'http://localhost:8000', apiKey: 'cgt_abc' }, baseEntry()),
            /400/
        );
    });
});

suite('verifyApiKey', () => {
    const originalFetch = globalThis.fetch;
    teardown(() => { globalThis.fetch = originalFetch; });

    test('returns ok with the student number on success', async () => {
        stubFetch(() => new Response(JSON.stringify({ student_number: '20231234' }), { status: 200 }));

        const result = await verifyApiKey('http://localhost:8000', 'cgt_abc');
        assert.deepStrictEqual(result, { ok: true, name: '20231234' });
    });

    test('stringifies a numeric student number', async () => {
        stubFetch(() => new Response(JSON.stringify({ student_number: 20231234 }), { status: 200 }));

        const result = await verifyApiKey('http://localhost:8000', 'cgt_abc');
        assert.deepStrictEqual(result, { ok: true, name: '20231234' });
    });

    test('falls back to "unknown" when the student number is missing', async () => {
        stubFetch(() => new Response(JSON.stringify({}), { status: 200 }));

        const result = await verifyApiKey('http://localhost:8000', 'cgt_abc');
        assert.deepStrictEqual(result, { ok: true, name: 'unknown' });
    });

    test('returns a friendly error for an invalid key', async () => {
        stubFetch(() => new Response(null, { status: 401 }));

        const result = await verifyApiKey('http://localhost:8000', 'cgt_bad');
        assert.deepStrictEqual(result, { ok: false, error: 'Invalid API key' });
    });

    test('returns an error when the request itself fails', async () => {
        stubFetch(() => { throw new TypeError('fetch failed'); });

        const result = await verifyApiKey('http://localhost:8000', 'cgt_abc');
        assert.strictEqual(result.ok, false);
        assert.match((result as { error: string }).error, /fetch failed/);
    });
});
