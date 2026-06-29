# Manually created infrastructure

The KV store for the airscore-api:

```
cd web/workers/airscore-api
bunx wrangler kv namespace create AIRSCORE_CACHE
bunx wrangler kv namespace create AIRSCORE_CACHE --preview
# Then update wrangler.toml with the returned IDs
```

# Automated deployments

See the .github/workflows/*.yml for details
