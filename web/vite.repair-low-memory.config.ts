import { mergeConfig } from 'vite'
import original from './vite.config'
export default mergeConfig(original, { build: { reportCompressedSize: false, rollupOptions: { maxParallelFileOps: 1 } } })
