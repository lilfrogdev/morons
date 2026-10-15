# Morons encrypted Pi credential store

`openEncryptedCredentialStore({ filePath, key })` implements the Pi 1.2
`CredentialStore` contract (`read`, metadata-only `list`, serialized `modify`,
`delete`). The host must supply an absolute path in an owner-private directory
and an independent 32-byte key. The store creates the directory with mode 0700,
the encrypted file and owner lock with mode 0600, and rejects existing files or
directories with wider permissions. It uses AES-256-GCM with a fresh nonce for
each atomic file replacement; it never persists or logs the key or plaintext.

The trusted host is responsible for obtaining and retaining the key, for
example from an OS secret store or a secure manual unlock. Do not place the key
in this repository, an HTTP request, a transcript, command-line arguments, or
an environment dump. Keep one long-lived store instance for the backend's Pi
`Models`; call `close()` at shutdown. A second owner fails closed on the lock.
After a crash, an operator must verify that the old process is stopped before
removing the stale `.lock` file. The lock is not a distributed lock: do not run
multiple backends against one credential file, share it over a network volume,
or copy a rotating OAuth session into independent owners.

This protects credentials at rest only while the host key remains separate.
It does not provide Morons account identity or remote OAuth session revocation.
Pi login remains a human-initiated provider operation.

On Windows, POSIX file modes do not prove the ACL is private. A Windows host
must provide a user-private directory and enforce its ACL before opening this
store. The one-owner lock is a local filesystem mechanism, not a network share
or high-availability coordination protocol.
