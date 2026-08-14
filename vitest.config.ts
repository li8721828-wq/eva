import { defineConfig } from 'vitest/config'
import path from 'path'

export default defineConfig({
  server: {
    // This Windows environment cannot resolve the localhost hostname through
    // getaddrinfo. Keep Vite/Vitest on the numeric loopback interface.
    host: '127.0.0.1',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src/renderer'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: true,
  },
})
