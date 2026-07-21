# Security policy

Please report vulnerabilities through the repository's private
[security advisory form](https://github.com/dayfinggg/claude-code-discord-presence/security/advisories/new).
Do not include credentials, OAuth tokens, transcripts, private hook payloads, or SSH configuration
in a public issue.

Only the latest release receives security fixes. The HTTP receiver binds to `127.0.0.1`, limits
request bodies, accepts telemetry-only routes, validates SSH aliases, and stores bounded local logs.
