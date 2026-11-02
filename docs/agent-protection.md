# Agent protection

Protection providers are installed, trusted plugins. They own checks, models,
policy UI and approval decisions. Buzz owns saved bindings, agent lifetimes,
native custody and the common dispatch gates. A missing provider, unsupported
runtime, failed check or cancelled check stops a protected action.

## Local storage upgrade

Before the first protection save, native Buzz asks the owner to upgrade local
agent storage. **This is a one-way upgrade for every agent on the device.**
Older Buzz builds cannot list, run or remove any local agents afterward, even
if all protection bindings and defaults are subsequently cleared. Development
Buzz shares this store with the installed app. Close other Buzz builds before
confirming, and retain a compatible build. Identities and credential-store keys
are preserved; this does not move or export keys.

Cancel leaves identity and defaults files unchanged. Earlier protection previews
also require confirmation at startup. Cancelling that startup upgrade leaves
Agents unavailable in the new process; restart to retry. Never-protected stores
remain in the older compatible format until explicit confirmation.

Version 4 stores all membership rows and a monotonic `protectionClock` together.
Policy changes and newly committed identities after opt-in allocate from that
clock. Joins copy the identity's generation; defaults-only writes, deletion and
forgetting the final identity preserve the clock. Re-importing the same public
key cannot revive an earlier generation. Protected durable runtime state uses a
new namespace, so an older preview's ambiguous history is not resumed. Codex records the
protection `stateKey` with each saved thread and resumes it only under the same
key, so a policy change, or moving between unprotected and protected, starts a
new thread.

An earlier protection preview could save a version-2 identity envelope that
omitted memberships still present in its sidecar. Buzz refuses that incomplete
state without changing files or keys. There is no automatic repair: restore a
complete identities backup before retrying. This guard does not apply to a
complete ordinary version-2 multi-community store.

## Provider and runtime contract

A plugin injects `agentProtection`. `register` installs its checker and native
process requirements; `registerModels` exposes its runtime's model choices and
bounded, tool-free completion. `snapshot`, `saveDefaults` and `saveAgent` read
and update owner defaults and per-identity bindings. Saves use native revision
checks; a plugin cannot replace another provider's existing binding. Defaults
apply only when committing a new or adopted identity.

An `AgentType` declares `protection: true` only when it routes all required
boundaries through `AgentHandle.protection`. Otherwise `protectionUnavailable`
explains why protected runs cannot start. `retire(key)` retires sessions for a
membership key before changing its policy. Captured handles stop acting after
retirement; local restoration of undelivered notes can still settle.

Installed plugins run in Buzz's trusted JavaScript context. Injecting this
service is not a separate permission grant or isolation boundary. Such plugins
can configure unbound identities/defaults and inspect policies. Completion with
`runtime: "agent"` selects a current agent's runtime/model configuration, then
calls that runtime provider's normal completion API; it does not grant an agent
handle or select a separate agent credential. Runtime providers retain credential
ownership. Install only plugins trusted with that authority.

## Action payloads and recovery

The common session gate checks cloned destinations and arguments. Built-in
file-backed `send`, `reply_in_subthread`, `mem_set`, `notes_set` and `canvas_set`
capture decoded text before review and execute that captured text. Protected
runtime readers declare a bundled `read-protected` process using the common
command helper's fixed system `base64` command. Delegated body and worker-selected
transcript reads inherit the captured native containment, including hidden
approval paths; they never fall back to an ordinary reader. Other plugins
exposing files to protected agents must provide that declared reader as well.
Protected
attachment uploads are refused before reading or uploading files because the
current text review contract cannot fully inspect them. Ordinary attachment
uploads are unchanged. Oversized actions fail closed rather than omit content.

If a provider is missing, re-enable or reinstall the same plugin ID, then use
its settings to change or clear its agent policies and owner defaults. Missing
providers never silently remove protection. There is currently no host-owned
remove-protection control for a missing provider.

## Containment scope

Native containment protects Buzz's approval machinery while a worker runs. It
is not general workstation isolation or a guarantee against code that runs later
outside Buzz. Runtime and installed-plugin code remain trusted. Declared native
artifacts are verified and staged before launch; that does not verify an entire
runtime dependency graph or defend against other unsandboxed same-user programs.
Broader restrictions on workspace writes, startup files and login jobs belong to
Sandpit.
