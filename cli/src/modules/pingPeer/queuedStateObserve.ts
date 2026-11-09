/** Session-local, read-only Hub queue observer. Never sends or resumes work. */
import { inspectQueuedState } from './pingPeer'
import { initializeToken } from '@/ui/tokenInit'

async function main() {
    const sessionId = process.env.HAPI_SESSION_ID
    if (!sessionId || process.stdin.isTTY) throw new Error('binding or input unavailable')
    const chunks: Buffer[] = []
    let size = 0
    for await (const chunk of process.stdin) {
        const bytes = Buffer.from(chunk)
        size += bytes.length
        if (size > 256) throw new Error('key too large')
        chunks.push(bytes)
    }
    const bytes = Buffer.concat(chunks)
    const key = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    await initializeToken()
    const states = await inspectQueuedState({ sessionId, requestKey: key })
    console.log(JSON.stringify({ read_only: true, observed_at: Date.now() / 1000,
        source: 'native_hapi_hub_queued_state', states,
        dispatch_authorized: false, recovery_authorized: false,
        source_authenticated: false, quiescence_verified: false,
        limitation: 'Native Hub authentication does not prove checkpoint/session binding, request content or task completion.' }))
}

if (import.meta.main) main().catch(() => {
    console.error('Hub queued-state observation unavailable; delivery remains unknown')
    process.exitCode = 1
})
