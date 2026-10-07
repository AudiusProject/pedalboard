import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Required config with no defaults (see src/config.ts).
    env: {
      audius_content_node_urls: 'http://audius-mediorum-1:1991',
      audius_api_url: 'http://audius-discovery-provider-1'
    }
  }
})
