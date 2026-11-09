# Private account quota snapshots

Server component for the CPA provider extension. Requires existing CLIProxyAPI
8.0.53 ABI1/schema6 plugin support, Python3.9+ on Linux, and Go1.22+cgo to build.
The collector uses Python3 stdlib only; the plugin uses Go stdlib only.

## Boundaries

The resource `GET /v0/resource/plugins/account-quota-linux-amd64/snapshot` requires
an explicitly provisioned Bearer client key. It never calls management or an
upstream. POST, query parameters and request bodies are rejected. Responses have
`Cache-Control: no-store`. It is not an administrative proxy or a new listener.
The reader key authorizes visibility of all accounts in this private deployment;
do not distribute it to clients that must not see those account quotas.

A systemd oneshot collector reads the management credential only on the server,
queries the account inventory and model registry, and calls only the fixed Codex
usage or Antigravity quota-summary endpoint through CPA's token-substituting
management API. No inference, auth-file download, login or token refresh is
initiated by this component. CPA itself owns credential handling. No retries.
One refresh at a time; a five-minute timer and a 110-second service deadline bound
work. Each network request has an eight-second timeout and two-megabyte body cap.

Snapshot `cpa.quota/v1` uses used percentages, UTC epoch milliseconds, opaque
HMAC account identifiers, prefix labels, provider, observation dates and generic
errors. No account emails, paths, upstream tokens or management responses are
saved. Missing quota data stays unavailable; missing resets/durations stay null.
A failed account retains its last valid windows marked stale. An inventory failure
retains the complete old snapshot marked stale. Reader clients must reject old
snapshots; reading does not reset their age. A valid empty inventory removes old
accounts. Disabled accounts are omitted.

Only Codex primary/secondary windows and Antigravity summary groups are supported.
Additional Codex credit balances or special limit categories are not collected.
Prefixes inferred from the account's registered model IDs are labels, never
identities; ambiguous or absent prefixes fall back to opaque IDs. Identity changes
in CPA may change the opaque ID. Keep the private identity salt to retain IDs.

## Deployment

Build `plugin` with `go test -race`, `go vet`, and
`go build -buildmode=c-shared -o account-quota-linux-amd64.so .`.
Keep build output outside the checkout. Install the binary in CPA's existing
architecture plugin directory, enable only its config entry, and retain all
other plugin entries and the Control Account binary unchanged.

Private data directory (0700): `plugins/quota-data` in the existing CPA mount.
`client-key`, `identity-salt` and `snapshot.json` must be 0600. The default plugin
path is `/CLIProxyAPI/plugins/quota-data`; `CPA_QUOTA_DIR` overrides it for tests.
Run `python3 collector.py <host-data-directory> <private-credentials-file>` with
a host credentials file containing `MANAGEMENT_KEY=...`. Never put its contents
in a unit, command line, environment dump or repository. Use a systemd timer
with `OnUnitInactiveSec=300`, `TimeoutStartSec=110`, `UMask=0077`,
`NoNewPrivileges=yes`, and `ProtectSystem=strict` plus an explicit writable data
path. The plugin itself needs only the reader key and sanitized snapshot.

Verify unauthenticated/wrong-key401, authenticated200, write-method405, identical
cached GETs and unchanged CPA model catalog. Inspect only sanitized summaries.
Client config: global `quotaEnabled: true`; existing apiKeyFile authenticates the
same-origin snapshot endpoint. No extra public port, tunnel change or admin key
in clients. Use TLS for non-loopback access.

Rollback: stop/disable the collector timer, disable only the account-quota plugin
entry, restore prior client quotaEnabled setting. Keep backups; do not overwrite
other changes or remove existing Control Account. Secrets and snapshots must
never be committed or included in a published package.
