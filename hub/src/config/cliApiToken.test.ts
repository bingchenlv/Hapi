import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getOrCreateCliApiToken } from './cliApiToken'

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-cli-token-test-'))
}

describe('getOrCreateCliApiToken', () => {
    const originalToken = process.env.CLI_API_TOKEN
    let dir: string | null = null

    afterEach(() => {
        if (originalToken === undefined) {
            delete process.env.CLI_API_TOKEN
        } else {
            process.env.CLI_API_TOKEN = originalToken
        }
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
        }
    })

    it('rejects namespace-suffixed env tokens', async () => {
        dir = makeTempDir()
        process.env.CLI_API_TOKEN = 'base-token:default'

        await expect(getOrCreateCliApiToken(dir)).rejects.toThrow('namespace suffixes are not accepted')
    })

    it('rejects namespace-suffixed file tokens', async () => {
        dir = makeTempDir()
        delete process.env.CLI_API_TOKEN
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ cliApiToken: 'base-token:default' }))

        await expect(getOrCreateCliApiToken(dir)).rejects.toThrow('namespace suffixes are not accepted')
    })
})
