// Prebundle installed runtime dependencies once with esbuild. Vite then emits
// these local ESM assets without retaining the entire vendor AST. No CDN or
// dependency upgrade. All entries share chunks, including a single React.
import { readFile, readdir, mkdir, writeFile, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { createHash } from 'node:crypto'
import ts from 'typescript'
const require = createRequire(import.meta.url)
const { build } = require(require.resolve('esbuild', { paths: [dirname(require.resolve('vite/package.json'))] }))

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const specifiers = new Set()
const namedExports = new Map()
const named = (module, name) => {
    if (!namedExports.has(module)) namedExports.set(module, new Set())
    namedExports.get(module).add(name)
}
const add = value => {
    if (value.startsWith('.') || value.startsWith('@/') || value.startsWith('@hapi/')
        || value.includes(':') || /\.(css|svg|png|woff2?)$/.test(value)) return
    specifiers.add(value)
}
async function scan(folder) {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = resolve(folder, entry.name)
        if (entry.isDirectory()) { if (!['dev', 'test', 'tests', '__tests__'].includes(entry.name)) await scan(path); continue }
        if (!/\.[jt]sx?$/.test(entry.name) || /\.(test|spec|d)\.[jt]sx?$/.test(entry.name)) continue
        const source = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true)
        const namespaces = new Map()
        for (const statement of source.statements) {
            if (ts.isImportDeclaration(statement) && !statement.importClause?.isTypeOnly && statement.importClause?.namedBindings
                && ts.isNamespaceImport(statement.importClause.namedBindings) && ts.isStringLiteral(statement.moduleSpecifier)) {
                namespaces.set(statement.importClause.namedBindings.name.text, statement.moduleSpecifier.text)
            }
        }
        const visit = node => {
            if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) && namespaces.has(node.expression.text)) {
                named(namespaces.get(node.expression.text), node.name.text)
            }
            if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
                const name = node.moduleSpecifier.text; add(name)
                const bindings = node.importClause?.namedBindings
                if (bindings && ts.isNamedImports(bindings)) {
                    for (const item of bindings.elements) if (!item.isTypeOnly) named(name, (item.propertyName ?? item.name).text)
                }
            }
            if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                add(node.moduleSpecifier.text)
                if (node.exportClause && ts.isNamedExports(node.exportClause)) for (const item of node.exportClause.elements) {
                    if (!item.isTypeOnly) named(node.moduleSpecifier.text, (item.propertyName ?? item.name).text)
                }
            }
            if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(node.arguments[0])) add(node.arguments[0].text)
            ts.forEachChild(node, visit)
        }
        visit(source)
    }
}
await scan(resolve(root, 'src'))
// Automatic JSX transform imports are not present in the TSX source AST.
add('react/jsx-runtime')
for (const name of ['jsx', 'jsxs', 'Fragment']) named('react/jsx-runtime', name)
const names = [...specifiers].sort()
const cache = resolve(root, '.local-vendor')
await mkdir(cache, { recursive: true })
const output = await mkdtemp(resolve(cache, 'build-'))
const entries = Object.fromEntries(names.map((name, i) => [`v${i}`, 'bounded-vendor:' + name]))
const virtualSources = new Map()
const interop = { name: 'bounded-vendor-interop', setup(plugin) {
    plugin.onResolve({ filter: /^bounded-vendor:/ }, args => ({ path: args.path.slice('bounded-vendor:'.length), namespace: 'bounded-vendor' }))
    plugin.onLoad({ filter: /.*/, namespace: 'bounded-vendor' }, args => {
        const module = JSON.stringify(args.path)
        const exports = [...(namedExports.get(args.path) ?? [])].filter(name => name !== 'default').sort()
        // Native browsers require static ESM named exports; a CJS entry alone
        // would expose only default (e.g. ReactDOM.flushSync would disappear).
        const contents = `export * from ${module};\n${exports.length ? `export { ${exports.join(', ')} } from ${module};` : ''}\nimport * as value from ${module}; export default value.default ?? value;`
        virtualSources.set('bounded-vendor:' + args.path, contents)
        return { contents, resolveDir: root, loader: 'js' }
    })
} }
const result = await build({ absWorkingDir: root, entryPoints: entries, bundle: true, splitting: true,
    format: 'esm', platform: 'browser', target: 'es2022', minify: true,
    outdir: output, chunkNames: 'chunk-[hash]', metafile: true,
    define: { 'process.env.NODE_ENV': '"production"' }, plugins: [interop], logLevel: 'info' })
const mapping = Object.fromEntries(names.map((name, i) => [name, `v${i}.js`]))
const hash = createHash('sha256')
const files = (await readdir(output)).sort()
for (const name of files) { hash.update(name); hash.update(await readFile(resolve(output, name))) }
const key = hash.digest('hex').slice(0, 16)
const destination = resolve(cache, key)
try { await rename(output, destination) } catch (error) {
    if (!['EEXIST', 'ENOTEMPTY'].includes(error.code)) throw error
    for (const name of files) {
        if (!(await readFile(resolve(output, name))).equals(await readFile(resolve(destination, name)))) throw new Error('Vendor hash collision')
    }
    await rm(output, { recursive: true }) // only this invocation's mkdtemp
}
const inputs = {}
for (const name of Object.keys(result.metafile.inputs)) {
    inputs[name] = createHash('sha256').update(virtualSources.get(name) ?? await readFile(resolve(root, name))).digest('hex')
}
await writeFile(resolve(cache, 'manifest.json'), JSON.stringify({ key, mapping, inputs }, null, 2))
console.log(JSON.stringify({ localVendor: key, entries: names.length, outputs: Object.keys(result.metafile.outputs).length, cdn: false }))
