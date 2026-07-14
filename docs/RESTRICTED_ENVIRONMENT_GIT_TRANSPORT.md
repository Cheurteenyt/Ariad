# Restricted-Environment Git Transport

**Status:** Maintainer/agent tool — NOT a runtime dependency

**Last verified:** 2026-07-14

**Helper:** `scripts/dev/asyncssh-git-transport.py`

## 1. Problem

In environments without native OpenSSH (`ssh` binary absent) and without
the GitHub CLI (`gh`), `git push` over SSH fails. The Python wrappers
(paramiko, ssh2-python/libssh2) that were tried exhibited:

```
send-pack: unexpected disconnect while reading sideband packet
send-pack: send disconnect: Broken pipe
wrapper exit 0 while remote had not advanced
```

Root causes:

| Wrapper | Failure |
|---------|---------|
| paramiko | `shutdown_write()` premature — channel closed before sideband `report-status-v2` finished |
| ssh2-python (libssh2) | assertion `_libssh2_transport_read: remainbuf >= 0` — buffer transport unstable |
| asyncssh (text mode) | `ProtocolError: 'utf-8' codec can't decode byte 0x9b` — tried to decode binary pack data as UTF-8 |
| **asyncssh (binary mode)** | **WORKS** — `encoding=None` preserves binary; channel lifecycle managed correctly |

## 2. Solution

**AsyncSSH 2.24.0** with `encoding=None` and direct stdin/stdout/stderr
file-descriptor piping via `conn.run()`.

### Why asyncssh works

1. `conn.run(..., encoding=None)` treats all data as raw `bytes` — no
   UTF-8 decode of pack data.
2. `conn.run()` handles the full SSH channel lifecycle:
   - writes stdin to the channel
   - sends EOF when stdin closes
   - reads stdout/stderr until remote EOF
   - waits for exit status
3. No manual `shutdown_write()` — asyncssh sends EOF at the right time
   (after stdin closes) and keeps reading until the server closes stdout.
4. Exit status is propagated correctly.

## 3. Usage

### Configuration

The helper reads configuration from environment variables (no hardcoded
secrets or paths):

```bash
# Required (with defaults):
export ASYNCSSH_CLIENT_KEY=~/.ssh/id_ed25519
export ASYNCSSH_KNOWN_HOSTS=~/.ssh/known_hosts
export ASYNCSSH_USERNAME=git
export ASYNCSSH_HOST=github.com
export ASYNCSSH_PORT=22
```

### Push

```bash
GIT_SSH_COMMAND="python3 scripts/dev/asyncssh-git-transport.py" \
    git push origin <branch>
```

### Self-test (offline, no key needed)

```bash
python3 scripts/dev/asyncssh-git-transport.py --self-test
```

Verifies:
- Binary passthrough (non-UTF-8 bytes survive unchanged)
- stdout/stderr separation
- Exit status propagation
- Command validation (accepts valid git commands)
- Injection rejection (refuses shell metacharacters, traversal)
- No implicit decode (`encoding=None` is used)

### Post-push verification (mandatory)

Never announce "push succeeded" based only on the wrapper's exit code.
Always verify the remote head:

```bash
git fetch origin

LOCAL_HEAD="$(git rev-parse HEAD)"
REMOTE_HEAD="$(git rev-parse origin/<branch>)"

test "$LOCAL_HEAD" = "$REMOTE_HEAD"

git diff --exit-code HEAD origin/<branch>

test "$(git rev-list --count origin/<branch>..HEAD)" = "0"
```

## 4. Binary contract

The helper treats ALL data as bytes:

```
stdin (git client)     → bytes
stdout (remote server)  → bytes
stderr (remote server)  → bytes
pack data               → bytes
sideband packets        → bytes
report-status packets   → bytes
```

**Forbidden** in the helper:

```
.decode()
.encode() implicit
text=True
universal_newlines=True
encoding="utf-8"
line-by-line reading of pack data
```

**Required:**

```python
encoding=None
```

## 5. SSH channel lifecycle

The git-receive-pack protocol:

```
1. Git client sends refs negotiation + flush.
2. Git client sends pack data.
3. Git client signals EOF on stdin.
4. git-receive-pack processes the pack.
5. Server sends sideband + report-status-v2.
6. Server closes stdout.
7. Wrapper reads exit status.
8. Wrapper closes connection.
```

**Critical rule:** never close the channel after only finishing writing.
Continue reading stdout/stderr until remote EOF, then wait for exit status.

Paramiko failed because `shutdown_write()` was called prematurely,
closing the channel before the sideband phase finished.

## 6. Security

The helper contains:

- No token
- No private key (path from env var)
- No hardcoded user path
- No password
- No `known_hosts=None` (host key verification is mandatory)
- No repository secret

### Command validation

Only these commands are allowed:

```
git-receive-pack <owner>/<name>.git
git-upload-pack <owner>/<name>.git
```

The repository path must match `^[A-Za-z0-9][A-Za-z0-9._-]*/[A-Za-z0-9][A-Za-z0-9._-]*\.git$`
(no leading dots, no `..` segments, no shell metacharacters).

**Refused:**

```
;   &&   |   $()   backticks   newline   path traversal   non-git commands
```

### Key file security

The client key must be mode `0600` (or stricter). The helper refuses
group/other-readable keys:

```
configuration error: client key ~/.ssh/id_ed25519 is group/other accessible (mode 0644);
expected 0600 or stricter. Run: chmod 600 ~/.ssh/id_ed25519
```

### Host key verification

The helper refuses to connect without a `known_hosts` file. To create
one:

```bash
# If ssh-keyscan is available:
ssh-keyscan -H github.com >> ~/.ssh/known_hosts

# If only paramiko is available:
python3 -c "
import paramiko, os
t = paramiko.Transport(('github.com', 22))
t.connect()
k = t.get_remote_server_key()
t.close()
with open(os.path.expanduser('~/.ssh/known_hosts'), 'a') as f:
    f.write(f'github.com ssh-{k.get_name().replace(\"ssh-\",\"\")} {k.get_base64()}\n')
"
```

## 7. Diagnostic and recovery

If the push fails, follow this runbook:

### 7.1 Check git state

```bash
git status --short --branch
git rev-parse HEAD
git rev-parse origin/<branch>
git merge-base --is-ancestor origin/<branch> HEAD && echo "ANCESTOR=OK"
git rev-list --count origin/<branch>..HEAD
git fsck --full
git count-objects -vH
```

### 7.2 Check for large objects

```bash
git rev-list --objects origin/<branch>..HEAD \
| git cat-file --batch-check='%(objecttype) %(objectsize) %(rest)' \
| sort -k2nr \
| head -30
```

### 7.3 Create recovery artifacts

```bash
mkdir -p /tmp/r169b-push-recovery

git bundle create /tmp/r169b-push-recovery/r169b-unpushed.bundle origin/<branch>..HEAD

git format-patch --binary --full-index --stdout origin/<branch>..HEAD \
> /tmp/r169b-push-recovery/r169b-unpushed.patch

git log --reverse --format=fuller origin/<branch>..HEAD \
> /tmp/r169b-push-recovery/r169b-unpushed-log.txt

sha256sum /tmp/r169b-push-recovery/r169b-unpushed.bundle /tmp/r169b-push-recovery/r169b-unpushed.patch \
> /tmp/r169b-push-recovery/SHA256SUMS

git bundle verify /tmp/r169b-push-recovery/r169b-unpushed.bundle
```

### 7.4 Transfer to maintainer

Hand off to a maintainer with native `ssh`:

```
r169b-unpushed.bundle
r169b-unpushed.patch
r169b-unpushed-log.txt
SHA256SUMS
```

The maintainer can apply with:

```bash
git fetch /path/to/r169b-unpushed.bundle HEAD
git merge FETCH_HEAD
git push origin <branch>
```

**Do not commit** the bundle, patch, or logs containing local paths.

## 8. Known limitations

- `conn.run()` buffers data in memory. For the current ~3.3 MiB pack
  this is fine. For very large pushes (>500 MiB), consider switching to
  `conn.create_process()` with explicit streaming tasks and `drain()`.
- The helper requires `asyncssh` to be installed in the Python
  environment. It is NOT an npm dependency and is NOT used by the
  Codebase Memory runtime or CI.
- The `-G` probe mode prints a fake SSH config to satisfy git's
  pre-push connectivity check.

## 9. Installation (maintainer environments only)

```bash
# In the Python environment used for git:
pip install asyncssh

# Set up keys:
chmod 600 ~/.ssh/id_ed25519
ssh-keyscan -H github.com >> ~/.ssh/known_hosts  # or use paramiko fallback

# Test:
python3 scripts/dev/asyncssh-git-transport.py --self-test

# Use:
GIT_SSH_COMMAND="python3 scripts/dev/asyncssh-git-transport.py" git push origin <branch>
```
