import { resolve } from 'path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        external: ['node-pty']
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    server: {
      // Do not depend on this machine resolving the localhost hostname.
      host: '127.0.0.1'
    },
    resolve: {
      alias: {
        '@': resolve('src/renderer')
      }
    },
    plugins: [tailwindcss()]
  }
})
