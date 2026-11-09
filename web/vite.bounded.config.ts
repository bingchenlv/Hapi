import { mergeConfig, type Plugin } from 'vite'
import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import original from './vite.repair-low-memory.config'

const manifest = JSON.parse(readFileSync(resolve(__dirname, '.local-vendor/manifest.json'), 'utf8')) as {
    key: string; mapping: Record<string, string>
}
const assetRoot = `assets/vendor-${manifest.key}`
const base = process.env.VITE_BASE_URL || '/'
const assets: Plugin = {
    name: 'bounded-local-vendor', apply: 'build',
    generateBundle() {
        const folder = resolve(__dirname, '.local-vendor', manifest.key)
        for (const name of readdirSync(folder)) {
            if (!/\.(js|css|wasm)$/.test(name)) throw new Error('Unexpected local vendor asset')
            this.emitFile({ type: 'asset', fileName: `${assetRoot}/${name}`, source: readFileSync(resolve(folder, name)) })
        }
    }
}
export default mergeConfig(original, {
    plugins: [assets], esbuild: { sourcemap: false },
    build: { sourcemap: false, rollupOptions: {
        external: Object.keys(manifest.mapping),
        output: { paths: Object.fromEntries(Object.entries(manifest.mapping).map(([key, file]) => [key, `${base}${assetRoot}/${file}`])) }
    } }
})
