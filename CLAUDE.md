# TaskScore

A webapp for analysing hanggliding / paragliding competition tasks.

# System Architecture

See [System Architecture](specs/system-architecture-spec.md)

# Tools

- Typescript
- Cloudflare Workers
- Cloudflare R2 for object storage
- Cloudflare D1 for relational data

# Project structure

- /explorations -- Exploratory code to explore ideas and tools. This code must not be used in production.

# Deployment
- Infrastructure as code patterns using the Cloudflare Wrangler CLI
- Domain: taskscore.shonky.info

# Documentation
- All features to be documented as specifications at `specs/{feature}-spec.md`

# Coding Preferences
- MUST always read the documentation for libraries and tools.
  - Use the Context7 tool
  - Use web documentation
- Place exploration code in the `explorations` directory. This code must not be used in production.
- Decisions MUST be explainable for scoring - so where possible, return explanations about decisions made so that the decisions can be shown to users, logged in audit logs, and used in unit testing.
