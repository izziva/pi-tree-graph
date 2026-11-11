# pi-tree-graph (Izziva derivative)

Session-tree visualization and Git shadow checkpoints for [Pi](https://pi.dev).

This repository is a derivative of the locally installed `pi-tree-graph` 0.1.0 package attributed to chao, distributed under the retained MIT license. The referenced upstream URL (`chao/pi-tree-graph`) was unavailable when this derivative was prepared. This repository does not claim upstream Git history.

## Behavior

- `/tg` (`/tree-graph`) displays the session tree. `g` restores a snapshot with confirmation.
- `/checkpoints`, `/checkpoint-restore <hash>`, and `/checkpoint-prune` operate on the current repository's shadow checkpoint store.
- The checkpoint extension is active only when the Pi session starts in a Git worktree (including a subdirectory). Session changes refresh that state. Outside Git, the graph and checkpoint commands are inactive.
- Before matching `write`, `edit`, and heuristic Bash writes, it snapshots the affected Git repository. This includes another repository reached by an explicit path or a simple `cd` command. Files outside Git are allowed without a snapshot.
- Snapshots are separate Git repositories at `~/.pi/agent/checkpoints/<sha256-of-canonical-worktree-root>`. The original repository's `.git`, index, and history are not used or changed. Worktrees have distinct identities.
- Snapshot content includes ignored files and `.env` files. **Secrets are stored locally in plaintext** in the user's checkpoint store and are never uploaded by this package. Checkpoint directories are private to the user.
- Only `.git`, `node_modules`, and `build` trees, plus the checkpoint store itself when inside the worktree, are excluded. Symlinks are recorded as links and are not followed.
- Snapshot failure blocks a matched write. Reads do not snapshot.

Bash matching is deliberately heuristic, not a shell parser. It recognizes redirections and common modifying commands, but cannot reliably detect indirect, script-driven, dynamically expanded, or remote writes. Treat it as best-effort protection, not a universal write barrier.

## Install

```sh
pi install git:github.com/izziva/pi-tree-graph
```

Requires `git` on `PATH`. The package retains the upstream MIT notice in `LICENSE`.

## Tests

Run `sh tests/run.sh` with Pi available on `PATH`. The test harness uses a temporary home and temporary Git repositories, then removes them.

## Snapshot retention

Automatic pruning is limited to shadow repos. Bundles preserve pruned snapshots. Settings:

| Variable | Default | Meaning |
|---|---:|---|
| `PI_CHECKPOINT_RETENTION_DAYS` | `30` | Prune commits older than this |
| `PI_CHECKPOINT_MIN_KEEP` | `50` | Always retain the newest N commits |
| `PI_CHECKPOINT_HARD_CAP` | `1000` | Maximum retained snapshots |
| `PI_CHECKPOINT_PRUNE` | `1` | Set to `0` to disable automatic pruning |

Historical tree entries with their former explicit `gitDir` remain restorable. New checkpoint commands resolve the active worktree in the current repository.

## License

MIT; see `LICENSE` for the original attribution and terms.
