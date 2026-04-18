# ADR-012: Container Security (Non-Root, ReadonlyFS)

**Status**: Accepted

## Context

Kea agent pods run in Kubernetes and handle untrusted web content via a headless browser. The container must follow security best practices to minimize blast radius if compromised.

## Decision

The agent Dockerfile and K8s pod spec enforce:

1. **Non-root user**: The container runs as a dedicated `kea` user (UID 1001). Playwright/Chromium runs in `--no-sandbox` mode under this user.
2. **Read-only root filesystem**: The pod's `securityContext` sets `readOnlyRootFilesystem: true`. Writable paths are mounted as volumes:
   - `/data` — `emptyDir` for SQLite database files.
   - `/tmp` — `emptyDir` for temporary files (Playwright profiles, downloads).
3. **No privilege escalation**: `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`.
4. **Multi-stage build**: Build stage compiles TypeScript and installs Playwright browsers. Runtime stage copies only the necessary artifacts.

## Alternatives Considered

- **Root user with read-only FS**: Reduces risk from filesystem modification but a compromised root process can still escape the container via kernel exploits. Non-root is strictly better.
- **Distroless base image**: Considered for the runtime stage. Rejected because Playwright requires glibc, shared libraries (libgbm, libnss), and a shell for browser launching. `node:22-slim` with `apt-get` is the practical choice.
- **gVisor/kata-containers**: Strong sandboxing but adds runtime complexity and may not be available on all clusters. Can be added as a pod-level annotation later without changing the image.

## Consequences

- The application cannot write to any path except mounted volumes. All file operations (SQLite, temp files, browser profiles) must target `/data` or `/tmp`.
- SQLite database path must be configured to `/data/kea.db` via environment variable or default.
- Playwright browser cache must be directed to `/tmp`.
- `emptyDir` volumes are ephemeral — data is lost on pod restart. This is acceptable since findings are reported to the operator before pod termination.
- The non-root user may need `--no-sandbox` for Chromium, which is standard practice for containerized browser automation.
- Pod security standards (restricted profile) are satisfied.
