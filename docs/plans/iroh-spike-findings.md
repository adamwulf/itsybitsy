# iroh Phase 0 spike findings

Phase 0 of [iroh-peering.md](iroh-peering.md). Run on 2026-11-15.

- Bun: `bun --version` → `1.3.10`
- Package: `@number0/iroh@1.2.0`, which pulls in `@number0/iroh-darwin-arm64@1.2.0`
- Machine: macOS (Darwin 27.3.0), Apple Silicon (arm64)
- Spike code: `spikes/iroh/` (its own `package.json` and `bun.lock`). Nothing
  under `src/`, the root `package.json`, `build.sh` or the root `bun.lock`
  changed. The root `tsconfig.json` now excludes `spikes`.

## Result

| Check | Result |
|---|---|
| A. Two plain-bun processes, dial by id alone over the n0 preset | **Pass** |
| B. Same with binaries built with the exact `ib` flags, run from `/private/tmp` with no node_modules | **Pass**: a plain `import` of `@number0/iroh` embeds the addon |
| C. Cost when the addon is never loaded | **+12,251,904 bytes; no measurable `--version` CPU change** |
| D. Relay-disabled loopback on `127.0.0.1` | **Pass**, with both `presetMinimal` + `RelayMode.disabled()` and `presetN0DisableRelay` |
| E. Clean exit after closing the connection and calling `ep.close()` | **Pass**: the process exits by itself |

The network was not blocked. `bun add` reached npm, and UDP and HTTPS to the
n0 relays and DNS worked (this agent runs with the kernel sandbox off).

## Spike files

| File | Purpose |
|---|---|
| `entry.ts` | CLI. `--version` is the no-op path. Every other command reaches iroh through `await import("./roles.ts")`. |
| `entry-baseline.ts` | `entry.ts` with the iroh import removed. This is the baseline for C. |
| `iroh.ts` | The one module that imports `@number0/iroh`. |
| `roles.ts` | `listen`, `dial`, `loopback`, `bind-only`. |
| `probe-api.ts` | Probes byte types, id formats, read limits and error shapes. |
| `measure.ts` | Startup CPU measurement for C. |
| `run-in.ts` | Runs a command with a given cwd. The agent harness forbids `cd`. |

All commands below were run from the repository root. `$SCRATCH` stands for
the agent's scratch directory. In the outputs, the machine's LAN IPv4 address
is replaced with `<lan-ipv4>` and its global IPv6 addresses with `<ipv6>`.
Some outputs are shortened: dropped lines or text are marked with `...` or
`…`. The A, B, D, round-3 C and `probe-api.ts` outputs are complete.

Setup:

```
$ bun add --cwd spikes/iroh @number0/iroh
bun add v1.3.10 (30e609e0)
Resolving dependencies
Resolved, downloaded and extracted [28]
Saved lockfile

installed @number0/iroh@1.2.0

2 packages installed [1.77s]
```

## A. Plain bun, two processes, dial by id alone

The listener generates a secret key, saves its 32 bytes as hex, reloads the
file, and confirms the reloaded key has the same id. It then binds with
`Endpoint.bind({ secretKey, alpns: [ALPN] })` (the n0 preset), where ALPN is
`itsybitsy/spike/1`. It waits for `ep.online()`, prints its id, and serves one
echo.

The dialer receives only the id string. It parses it with
`EndpointId.fromString(s)` and binds with `Endpoint.bind({ alpns: [] })` (the
default n0 preset). It then calls `ep.connect(new EndpointAddr(id), ALPN)`,
with no ticket and no addresses, and opens a bi stream.

Listener (started in the background):

```
$ bun spikes/iroh/entry.ts listen $SCRATCH/a-listener.key
[entry] dynamic import of roles.ts took 214.9 ms
[key 2026-11-16T04:41:25.175Z] generated; toBytes() is Array of length 32
[key 2026-11-16T04:41:25.178Z] saved to $SCRATCH/a-listener.key; generated id 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[key 2026-11-16T04:41:25.178Z] reloaded id  1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085 (same as generated: true)
[listener 2026-11-16T04:41:25.189Z] net=n0; ep.id() = 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085 (equals key's public: true)
[listener 2026-11-16T04:41:28.364Z] online; home relay https://use1-1.relay.n0.iroh.link./
[listener 2026-11-16T04:41:28.364Z] LISTENER_ID 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[listener 2026-11-16T04:41:36.051Z] conn.remoteId() = 2e5215628b704b4f3a365d56216f217285148198c04730794aed6be57ec80476
[listener 2026-11-16T04:41:36.051Z] paths: relay https://use1-1.relay.n0.iroh.link./ (selected)
[listener 2026-11-16T04:41:36.072Z] received 21 bytes: "hello from 2e5215628b"
[listener 2026-11-16T04:41:36.113Z] connection closed: closed by peer: bye (code 0)
[listener 2026-11-16T04:41:36.163Z] ep.close() resolved; isClosed true
[entry 2026-11-16T04:41:36.163Z] main returned
[entry 2026-11-16T04:41:36.164Z] process exiting, code 0

[exited with code 0]
```

Dialer:

```
$ bun spikes/iroh/entry.ts dial 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[entry] dynamic import of roles.ts took 12.1 ms
[dialer 2026-11-16T04:41:35.454Z] net=n0; DIALER_ID 2e5215628b704b4f3a365d56216f217285148198c04730794aed6be57ec80476
[dialer 2026-11-16T04:41:35.454Z] dialing 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[dialer 2026-11-16T04:41:36.003Z] connected in 549 ms; remoteId 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[dialer 2026-11-16T04:41:36.004Z] paths: relay https://use1-1.relay.n0.iroh.link./ (selected)
[dialer 2026-11-16T04:41:36.112Z] echo: "hello from 2e5215628b" (matches: true)
[dialer 2026-11-16T04:41:37.113Z] ep.close() resolved; isClosed true
[entry 2026-11-16T04:41:37.113Z] main returned
[entry 2026-11-16T04:41:37.114Z] process exiting, code 0
```

**Pass.** The listener's `conn.remoteId()` (`2e5215628b…0476`) equals the
dialer's id. The echo matches, and the reloaded key has the same id.

Notes:

- `ep.online()` resolved 3.2 s after bind.
- The dial took about 550 ms and went over the relay. Both ends ran on one
  machine, and the exchange was too short to see a direct path take over.
- The dialer's `ep.close()` took about 1.0 s under the n0 preset (the same in
  check B). The listener's took about 50 ms.

## B. Compiled with the exact `ib` flags, run from a fresh directory

Build:

```
$ bun build --compile --minify --sourcemap --bytecode --format=esm --no-compile-autoload-dotenv --no-compile-autoload-bunfig spikes/iroh/entry.ts --outfile spikes/iroh/out/plain-import/iroh-spike
  [13ms]  minify  -12.1 MB (estimate)
   [5ms]  bundle  6 modules
 [123ms] compile  spikes/iroh/out/plain-import/iroh-spike
```

Copy into a fresh directory with no node_modules. Check A's key file is
copied too, so the compiled listener must reload it:

```
$ mkdir /private/tmp/iroh-spike-b
$ cp spikes/iroh/out/plain-import/iroh-spike $SCRATCH/a-listener.key /private/tmp/iroh-spike-b/
$ ls -la /private/tmp/iroh-spike-b/
-rw-r--r--     1 adamwulf  wheel        65 Nov 15 22:42 a-listener.key
-rwxr-xr-x     1 adamwulf  wheel  73205648 Nov 15 22:42 iroh-spike
```

Listener (compiled, cwd `/private/tmp/iroh-spike-b`, started in the
background):

```
$ bun spikes/iroh/run-in.ts /private/tmp/iroh-spike-b ./iroh-spike listen a-listener.key
[entry] dynamic import of roles.ts took 331.6 ms
[key 2026-11-16T04:42:23.736Z] loaded existing key from a-listener.key; id 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[listener 2026-11-16T04:42:23.757Z] net=n0; ep.id() = 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085 (equals key's public: true)
[listener 2026-11-16T04:42:26.925Z] online; home relay https://use1-1.relay.n0.iroh.link./
[listener 2026-11-16T04:42:26.925Z] LISTENER_ID 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[listener 2026-11-16T04:42:31.392Z] conn.remoteId() = 080137c1d2f0ca9476ffa8988b70d169dd712b72abe5d5ae54c335bc9fbc8012
[listener 2026-11-16T04:42:31.393Z] paths: relay https://use1-1.relay.n0.iroh.link./ (selected)
[listener 2026-11-16T04:42:31.415Z] received 21 bytes: "hello from 080137c1d2"
[listener 2026-11-16T04:42:31.457Z] connection closed: closed by peer: bye (code 0)
[listener 2026-11-16T04:42:31.505Z] ep.close() resolved; isClosed true
[entry 2026-11-16T04:42:31.505Z] main returned
[entry 2026-11-16T04:42:31.506Z] process exiting, code 0

[exited with code 0]
```

Dialer (compiled, same directory):

```
$ bun spikes/iroh/run-in.ts /private/tmp/iroh-spike-b ./iroh-spike dial 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[entry] dynamic import of roles.ts took 223.7 ms
[dialer 2026-11-16T04:42:30.787Z] net=n0; DIALER_ID 080137c1d2f0ca9476ffa8988b70d169dd712b72abe5d5ae54c335bc9fbc8012
[dialer 2026-11-16T04:42:30.788Z] dialing 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[dialer 2026-11-16T04:42:31.343Z] connected in 555 ms; remoteId 1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
[dialer 2026-11-16T04:42:31.343Z] paths: relay https://use1-1.relay.n0.iroh.link./ (selected)
[dialer 2026-11-16T04:42:31.456Z] echo: "hello from 080137c1d2" (matches: true)
[dialer 2026-11-16T04:42:32.459Z] ep.close() resolved; isClosed true
[entry 2026-11-16T04:42:32.459Z] main returned
[entry 2026-11-16T04:42:32.459Z] process exiting, code 0
```

**Pass.** The compiled listener reloaded the key that A saved and came up with
the same id. Its `conn.remoteId()` equals the compiled dialer's id.

To prove the addon comes from inside the binary, I renamed
`spikes/iroh/node_modules` and ran the compiled binary again:

```
$ mv spikes/iroh/node_modules spikes/iroh/node_modules.off
$ bun spikes/iroh/run-in.ts /private/tmp/iroh-spike-b ./iroh-spike loopback --net minimal
[entry] dynamic import of roles.ts took 223.6 ms
[loopback ...] net=minimal; server id b0b3d337…50ce; addrs ["<lan-ipv4>:63050", "<ipv6>:55293", ...]
...
[loopback-client 2026-11-16T04:43:02.950Z] echo: "loopback hello" (matches: true)
...
[entry 2026-11-16T04:43:02.951Z] process exiting, code 0
$ mv spikes/iroh/node_modules.off spikes/iroh/node_modules
```

The root `node_modules` does not contain `@number0/iroh` either.

**Import pattern that embedded the addon: a plain import of `@number0/iroh`**
(`export { Endpoint, … } from "@number0/iroh"` in `iroh.ts`, which `roles.ts`
reaches through a dynamic import). No direct require of the `.node` file and no
`NAPI_RS_NATIVE_LIBRARY_PATH` were needed.

It works because napi-rs's generated `index.js` contains a literal
`require('@number0/iroh-darwin-arm64')`. That package's `main` is
`iroh.darwin-arm64.node`, so Bun's bundler resolves the require to the `.node`
file and embeds it. The build's "6 modules" and "-12.1 MB" lines, and the size
difference in C, show this. The `require('./iroh.darwin-arm64.node')` that
`index.js` tries first fails at runtime, is caught, and the loader falls
through to the embedded package.

## C. Cost when the addon is never loaded

Both builds use the exact flags from B. The baseline is `entry-baseline.ts`,
which is `entry.ts` with the iroh dynamic import removed. The `--version` path
is the same code in both.

```
$ bun build --compile --minify --sourcemap --bytecode --format=esm --no-compile-autoload-dotenv --no-compile-autoload-bunfig spikes/iroh/entry-baseline.ts --outfile spikes/iroh/out/baseline/iroh-spike-baseline
  [68ms]  minify
  [59ms]  bundle  1 modules
 [160ms] compile  spikes/iroh/out/baseline/iroh-spike-baseline
```

**Sizes** (`ls -l`, final builds):

| File | Bytes |
|---|---|
| baseline binary (no iroh) | 60,953,744 |
| binary with iroh behind a dynamic import | 73,222,160 |
| difference | **+12,268,416** (+20.1%) |
| `iroh.darwin-arm64.node` | 12,043,104 |

The first build in B was 73,205,648 bytes (+12,251,904). It grew by 16 KB when
the `bind-only` and `load-only` probes were added to `roles.ts` and `entry.ts`.
Nearly all of the growth is the addon. Applied to `ib`, the binary would go
from about 71 MB to about 83 MB.

**Startup CPU of `--version`.** The tool is `spikes/iroh/measure.ts`. It runs
3 warm-ups, then N runs through `Bun.spawn`, and reads each child's
`resourceUsage()` (rusage from `wait4(2)`). CPU is user + system time; the
table shows the median of 30 runs. I ran three rounds in alternating order:

| Round | baseline cpu ms (median, min–max) | with iroh cpu ms (median, min–max) |
|---|---|---|
| 1 | 8.8 (8.1–9.9) | 8.7 (8.2–10.7) |
| 2 | 8.7 (8.2–9.1) | 9.0 (8.5–10.1) |
| 3 (final builds) | 8.5 (8.1–10.5) | 9.1 (8.6–10.3) |

The output of round 3:

```
$ bun spikes/iroh/measure.ts 30 spikes/iroh/out/baseline/iroh-spike-baseline --version
spikes/iroh/out/baseline/iroh-spike-baseline --version  (30 runs after 3 warm-ups)
  cpu (user+sys) ms: median 8.5  min 8.1  max 10.5
  user ms:           median 5.2  min 5.0  max 5.7
  sys ms:            median 3.2  min 3.1  max 4.8
  wall ms:           median 9.5  min 9.0  max 11.4
  max RSS MB:        median 18.8  min 18.7  max 18.8
$ bun spikes/iroh/measure.ts 30 spikes/iroh/out/plain-import/iroh-spike --version
spikes/iroh/out/plain-import/iroh-spike --version  (30 runs after 3 warm-ups)
  cpu (user+sys) ms: median 9.1  min 8.6  max 10.3
  user ms:           median 5.5  min 5.2  max 5.9
  sys ms:            median 3.6  min 3.3  max 4.4
  wall ms:           median 10.5  min 10.0  max 12.4
  max RSS MB:        median 19.3  min 19.3  max 19.4
```

The medians differ by -0.1 to +0.6 ms and the ranges overlap, which is within
noise. Max RSS is 0.5 MB higher. Carrying the addon does not measurably slow a
path that never loads it.

**Extra: the cost of actually loading the addon.** `load-only` performs the
dynamic import and returns:

```
$ bun spikes/iroh/measure.ts 15 spikes/iroh/out/plain-import/iroh-spike load-only
  cpu (user+sys) ms: median 34.6  min 30.3  max 37.8
  wall ms:           median 230.4  min 223.1  max 244.0
  max RSS MB:        median 42.8  min 42.7  max 42.8
$ bun spikes/iroh/measure.ts 15 bun spikes/iroh/entry.ts load-only
  cpu (user+sys) ms: median 25.1  min 23.9  max 26.2
  wall ms:           median 24.9  min 24.3  max 26.8
  max RSS MB:        median 37.4  min 37.3  max 37.5
```

An earlier round of the compiled `load-only` gave a 402 ms median wall time
with the same CPU (32.9 ms).

In the compiled binary, loading the addon costs about 25 ms of CPU but
**230–400 ms of wall time**, on every run. Under plain bun the same load takes
25 ms of wall time. The one exception is the very first load after
`bun add`, which took 215 ms; after that it took 12 ms.

My explanation, not verified: the compiled binary writes the embedded addon to
a new temp file in each process, and macOS checks each new file before
`dlopen`. That check runs in a system daemon, so it shows up as wall time but
not as this process's CPU. `lsof` is not allowed in this sandbox, so I could
not see the temp path. After about 40 compiled loads, `find` found no leftover
large files in `$TMPDIR` or `/private/tmp`, so the copies are cleaned up.

This is fine for `ib watch`, which loads the addon once in the background.
`ib peer` commands should not load it (see the plan notes below).

## D. Loopback without network

Both endpoints have relays disabled, and the dialer uses
`new EndpointAddr(id, null, ["127.0.0.1:PORT"])` with PORT taken from
`ep.addr().directAddresses()`.

In one process, with `presetMinimal` + `RelayMode.disabled()` (no external
dependencies):

```
$ bun spikes/iroh/entry.ts loopback --net minimal
[entry] dynamic import of roles.ts took 12.4 ms
[loopback 2026-11-16T04:42:49.898Z] net=minimal; server id 1b8b80a4d2fdbd86e00f9cbab624c37fe6e1ff3281c129a145ccb6dbd1c0e485; addrs ["<lan-ipv4>:62607","<ipv6>:55190","<ipv6>:55190","<ipv6>:55190"]
[loopback 2026-11-16T04:42:49.904Z] client id 07f16fa71139d1c82c40d5a1f211cf560025f9fade2378b342cb2e6229c1f0ff
[loopback-client 2026-11-16T04:42:49.906Z] connected in 1 ms; remoteId 1b8b80a4d2fdbd86e00f9cbab624c37fe6e1ff3281c129a145ccb6dbd1c0e485
[loopback-client 2026-11-16T04:42:49.906Z] paths: ip 127.0.0.1:62607 (selected)
[loopback-server 2026-11-16T04:42:49.906Z] conn.remoteId() = 07f16fa71139d1c82c40d5a1f211cf560025f9fade2378b342cb2e6229c1f0ff
[loopback-server 2026-11-16T04:42:49.906Z] paths: ip 127.0.0.1:60834 (selected)
[loopback-server 2026-11-16T04:42:49.907Z] received 14 bytes: "loopback hello"
[loopback-client 2026-11-16T04:42:49.908Z] echo: "loopback hello" (matches: true)
[loopback-server 2026-11-16T04:42:49.908Z] connection closed: closed by peer: bye (code 0)
[loopback 2026-11-16T04:42:49.908Z] both endpoints closed
[entry 2026-11-16T04:42:49.908Z] main returned
[entry 2026-11-16T04:42:49.908Z] process exiting, code 0
```

In one process, with `presetN0DisableRelay` (discovery still on):

```
$ bun spikes/iroh/entry.ts loopback --net n0-norelay
[entry] dynamic import of roles.ts took 11.9 ms
[loopback 2026-11-16T04:42:55.164Z] net=n0-norelay; server id 32222fe433c63cca311b011e5e460076455fea69d960e56a3da48a7b1f666b47; addrs ["<lan-ipv4>:55011","<ipv6>:55790","<ipv6>:55790","<ipv6>:55790"]
[loopback 2026-11-16T04:42:55.170Z] client id 3e8fd6dd7f313a1146d76572f9ce891595f981e9734c9906ad66fbc34acd2c69
[loopback-client 2026-11-16T04:42:55.172Z] connected in 1 ms; remoteId 32222fe433c63cca311b011e5e460076455fea69d960e56a3da48a7b1f666b47
[loopback-client 2026-11-16T04:42:55.172Z] paths: ip 127.0.0.1:55011 (selected)
[loopback-server 2026-11-16T04:42:55.172Z] conn.remoteId() = 3e8fd6dd7f313a1146d76572f9ce891595f981e9734c9906ad66fbc34acd2c69
[loopback-server 2026-11-16T04:42:55.172Z] paths: ip 127.0.0.1:64729 (selected)
[loopback-server 2026-11-16T04:42:55.175Z] received 14 bytes: "loopback hello"
[loopback-client 2026-11-16T04:42:55.176Z] echo: "loopback hello" (matches: true)
[loopback-server 2026-11-16T04:42:55.176Z] connection closed: closed by peer: bye (code 0)
[loopback 2026-11-16T04:42:55.176Z] both endpoints closed
[entry 2026-11-16T04:42:55.176Z] main returned
[entry 2026-11-16T04:42:55.176Z] process exiting, code 0
```

In two processes, with a compiled listener in `/private/tmp/iroh-spike-b` and
a plain-bun dialer:

```
$ bun spikes/iroh/run-in.ts /private/tmp/iroh-spike-b ./iroh-spike listen d-listener.key --net minimal
[entry] dynamic import of roles.ts took 227.0 ms
[key 2026-11-16T04:43:10.051Z] generated; toBytes() is Array of length 32
[key 2026-11-16T04:43:10.053Z] saved to d-listener.key; generated id f0e845543cf0206852a84aa710c59866d9fadebe593608b4f750fba1b190ad37
[key 2026-11-16T04:43:10.053Z] reloaded id  f0e845543cf0206852a84aa710c59866d9fadebe593608b4f750fba1b190ad37 (same as generated: true)
[listener 2026-11-16T04:43:10.069Z] net=minimal; ep.id() = f0e845543cf0206852a84aa710c59866d9fadebe593608b4f750fba1b190ad37 (equals key's public: true)
[listener 2026-11-16T04:43:10.069Z] direct addresses ["<lan-ipv4>:50175","<ipv6>:59647","<ipv6>:59647","<ipv6>:59647"]; port 50175
[listener 2026-11-16T04:43:10.069Z] LISTENER_ID f0e845543cf0206852a84aa710c59866d9fadebe593608b4f750fba1b190ad37
[listener 2026-11-16T04:43:22.690Z] conn.remoteId() = 2f2f3565bb97908236e1a5c748532000701628f13ed06cd1585997273271e5f0
[listener 2026-11-16T04:43:22.690Z] paths: ip 127.0.0.1:57302 (selected)
[listener 2026-11-16T04:43:22.691Z] received 21 bytes: "hello from 2f2f3565bb"
[listener 2026-11-16T04:43:22.692Z] connection closed: closed by peer: bye (code 0)
[listener 2026-11-16T04:43:22.692Z] ep.close() resolved; isClosed true
[entry 2026-11-16T04:43:22.692Z] main returned
[entry 2026-11-16T04:43:22.693Z] process exiting, code 0

$ bun spikes/iroh/entry.ts dial f0e845543cf0206852a84aa710c59866d9fadebe593608b4f750fba1b190ad37 --net minimal --port 50175
[entry] dynamic import of roles.ts took 13.2 ms
[dialer 2026-11-16T04:43:22.686Z] net=minimal; DIALER_ID 2f2f3565bb97908236e1a5c748532000701628f13ed06cd1585997273271e5f0
[dialer 2026-11-16T04:43:22.686Z] dialing f0e845543cf0206852a84aa710c59866d9fadebe593608b4f750fba1b190ad37 addrs=[127.0.0.1:50175]
[dialer 2026-11-16T04:43:22.689Z] connected in 2 ms; remoteId f0e845543cf0206852a84aa710c59866d9fadebe593608b4f750fba1b190ad37
[dialer 2026-11-16T04:43:22.689Z] paths: ip 127.0.0.1:50175 (selected)
[dialer 2026-11-16T04:43:22.692Z] echo: "hello from 2f2f3565bb" (matches: true)
[dialer 2026-11-16T04:43:22.692Z] ep.close() resolved; isClosed true
[entry 2026-11-16T04:43:22.692Z] main returned
[entry 2026-11-16T04:43:22.692Z] process exiting, code 0
```

**Pass.** It works with both presets, in one process and in two, and a
connect takes 1–2 ms.

- Without `bindAddr`, `addr()` does not list `127.0.0.1`. It lists the LAN
  and global IPv6 addresses of a wildcard socket, and dialing `127.0.0.1` on
  that port works.
- With `b.bindAddr("127.0.0.1:0")` (used in `probe-api.ts`), `boundSockets()`
  is `["127.0.0.1:PORT","[::]:PORT2"]` and `addr()` lists `127.0.0.1:PORT`
  first. The IPv6 socket still binds the wildcard address.
- I could not turn the network off to prove `presetMinimal` never touches it.
  Its doc comment says "no external dependencies", and a 2 ms dial agrees.

## E. Clean exit

**Pass.** After the connection is closed and `ep.close()` resolves, the process
exits by itself, every time, in A, B and D. This covers the listener and
dialer, plain bun and compiled builds, and all three presets. The `exited with
code 0` and `process exiting` lines come about 1 ms after `main returned`, and
the unref'd 5 s "STILL ALIVE" timer in `entry.ts` never fired.

Extra probes with `bind-only`, to see what holds the process:

```
$ bun spikes/iroh/entry.ts bind-only --net minimal
[bind-only ...] returning WITHOUT ep.close()
[entry 2026-11-16T04:45:14.899Z] main returned
[entry 2026-11-16T04:45:14.899Z] process exiting, code 0

$ bun spikes/iroh/entry.ts bind-only --net n0          (online, relay connected, no close)
[bind-only ...] returning WITHOUT ep.close()
[entry 2026-11-16T04:45:49.331Z] main returned
[entry 2026-11-16T04:45:49.331Z] process exiting, code 0

$ bun spikes/iroh/entry.ts bind-only --net minimal --accept --close
[bind-only 2026-11-16T04:45:25.587Z] acceptNext() left pending
[bind-only 2026-11-16T04:45:25.588Z] ep.close() resolved
[entry 2026-11-16T04:45:25.588Z] main returned
[bind-only 2026-11-16T04:45:25.588Z] pending acceptNext() resolved: null
[entry 2026-11-16T04:45:25.588Z] process exiting, code 0

$ bun spikes/iroh/entry.ts bind-only --net minimal --accept      (no close)
[bind-only 2026-11-16T04:45:30.868Z] acceptNext() left pending
[bind-only 2026-11-16T04:45:30.868Z] returning WITHOUT ep.close()
[entry 2026-11-16T04:45:30.868Z] main returned
[entry 2026-11-16T04:45:35.870Z] STILL ALIVE 5 s after main returned
(stopped by hand)
```

A bound endpoint, even one online with a relay connection, does not keep Bun
alive. A pending native call such as `acceptNext()` does. `ep.close()`
resolves a pending `acceptNext()` with `null`, and the process then exits.

## API surprises

Output of `bun spikes/iroh/probe-api.ts` (relay-disabled loopback, server
bound to `127.0.0.1:0`):

```
SecretKey.toBytes() type: Array length 32
EndpointId.toString(): "ed7ddedaf4531c2771422cf5b607ea9857c473f32e3e51b383cedf8b6bd90bfa" (length 64)
EndpointId.fmtShort(): "ed7ddedaf4"
SecretKey.fromBytes(Uint8Array): throws Error message="Failed to get Array length" code="ArrayExpected" own keys ["code"]
SecretKey.fromBytes(Buffer): throws Error message="Failed to get Array length" code="ArrayExpected" own keys ["code"]
SecretKey.fromBytes(31 bytes): throws Error message="SecretKey requires exactly 32 bytes" code="GenericFailure" own keys ["code"]
SecretKey.fromBytes([256, ...]): throws Error message="Failed to convert u32 to u8" code="GenericFailure" own keys ["code"]
EndpointId.fromString(uppercase hex): throws Error message="failed to decode hex string" code="GenericFailure" own keys ["code"]
EndpointId.fromString(fmtShort): throws Error message="invalid length" code="GenericFailure" own keys ["code"]
EndpointId.fromString('not-an-id'): throws Error message="invalid length" code="GenericFailure" own keys ["code"]
EndpointId.fromString(' ' + id): throws Error message="invalid length" code="GenericFailure" own keys ["code"]
server bound sockets (bindAddr 127.0.0.1:0): ["127.0.0.1:65113","[::]:52357"]
server addr().directAddresses(): ["127.0.0.1:65113","<ipv6>:52357","<ipv6>:52357","<ipv6>:52357"]
writeAll(Uint8Array): throws Error message="Failed to get Array length" code="ArrayExpected" own keys ["code"]
recv.read(65536) on a 100000-byte stream returns: Array of 2582 bytes
recv.readToEnd(1000) on the remaining bytes: throws Error message="TooLong" code="GenericFailure" own keys ["code"]
recv.readToEnd(1000000): 100000 bytes
recv.read(10) after end of stream: Array of 0
  [server] per-connection error: Error message="TransportError(Error { code: Code::crypto(78), frame: None, reason: \"peer doesn't support any known protocol\", crypto: Some(NoApplicationProtocol) })" code="GenericFailure" own keys ["code"]
connect with an ALPN the server does not offer: throws Error message="aborted by peer: the cryptographic handshake failed: error 120: peer doesn't support any known protocol" code="GenericFailure" own keys ["code"]
connect to a random id at the server's address: throws Error message="the cryptographic handshake failed: error 48: invalid peer certificate: UnknownIssuer" code="GenericFailure" own keys ["code"]
  took ms: 2
  [server] per-connection error: Error message="aborted by peer: the cryptographic handshake failed: error 48: invalid peer certificate: UnknownIssuer" code="GenericFailure" own keys ["code"]
connect to a closed port 127.0.0.1:9 (relays off, no discovery): throws Error message="timed out" code="GenericFailure" own keys ["code"]
  took ms: 30003
connect after the failures above took ms: 2
closeReason() after local close: "closed"
  [server] per-connection error: Error message="ApplicationClosed(ApplicationClose { error_code: 42, reason: b\"bye-reason\" })" code="GenericFailure" own keys ["code"]
openBi() on a closed connection: throws Error message="LocallyClosed" code="GenericFailure" own keys ["code"]
Endpoint.connect after close: throws Error message="Endpoint is closed" code="GenericFailure" own keys ["code"]
probe done
```

Dialing an id that is not online, through the n0 preset
(`bun spikes/iroh/probe-api.ts --n0-unknown`):

```
n0 connect to random unknown id: throws Error message="No addressing information available\nCaused by:\n    All address lookup services failed or produced no results\n    Service 'pkarr' failed: Error resolving http request\n    Service 'dns' failed: no calls succeeded: [Failed to resolve TXT recordFailed to resolve TXT record…]" code="GenericFailure" own keys ["code"]
  took ms: 3743
```

What the probes show:

1. **Ids are 64-character lowercase hex, not base32.** `EndpointId.toString()`
   returns hex, and `fmtShort()` returns the first 10 hex characters.
   `fromString` accepts only that exact form: it rejects uppercase hex,
   leading whitespace and short ids. Input has to be trimmed and lowercased
   before parsing.
2. **Every byte buffer is a plain JS `Array<number>`,** both in and out.
   `Uint8Array` and `Buffer` are rejected with `code: "ArrayExpected"`, and a
   value over 255 is rejected rather than truncated. A thin wrapper should
   convert at the boundary.
3. **Every error is a plain `Error` with `code: "GenericFailure"`** (or
   `"ArrayExpected"` for a wrong argument type). The meaning is only in the
   message text, which is often a Rust debug string, sometimes multi-line.
   Errors can only be classified by matching the message.
4. **`read(limit)` returns whatever chunk has arrived,** up to `limit` (here
   2,582 or 9,515 bytes of a 100,000-byte stream). At end of stream it returns
   an empty array, not `null`. `readToEnd(limit)` throws `"TooLong"` when the
   stream is longer than `limit`. Message framing (the plan's newline-delimited
   JSON) has to buffer across reads, or use one message per stream with
   `readToEnd(limit)` as the size cap.
5. **A failed handshake rejects `accept()`/`connect()` on the server side.**
   This happens on an ALPN mismatch or when a dialer expects a different id.
   On the first run of the probe, the accept loop had no per-connection
   `try/catch`, and one ALPN mismatch killed it. After that, every connect to
   that endpoint hung until it timed out after 30 s. An accept loop must
   catch errors per connection.
6. **A dial can take a long time to fail.** A random id at a live address
   fails in 2 ms. An id unknown to n0 discovery fails in about 3.7 s. A
   direct address where nothing answers times out after 30 s. I did not test
   a known peer that has gone offline; it could take up to 30 s if its old
   discovery record still points at an address.
7. `new EndpointAddr(id)` takes an `EndpointId` object, not a string:
   `new EndpointAddr(EndpointId.fromString(s))`.
8. `Endpoint.bind()` takes `{ secretKey, alpns, bindAddr }`. Relay and
   discovery choices need `Endpoint.builder()` and a preset function. A
   builder's `bind()` can be called only once.

## What this changes in the plan

- **Id format.** Replace "base32" in Research findings with 64-character
  lowercase hex, and the short id with 10 hex characters. In the Peers dialog,
  "enter B's id" means pasting 64 hex characters. Normalize the input (trim,
  lowercase) before `EndpointId.fromString`.
- **Wrapper.** `src/peers/` should wrap the addon so that bytes are converted
  at the boundary and errors are turned into short messages.
- **Accept loop.** Catch errors per connection (Reconnection, Pairing).
- **5 s poller.** Never start a new dial to a peer while the last one is still
  pending, since a dial can take up to 30 s to fail. Show the last error text
  in the peer state.
- **Shutdown.** `ib watch` must call `ep.close()` on exit, or exit with
  `process.exit()`, because a pending `acceptNext()` keeps Bun alive. The
  dialer-side `close()` can take about 1 s under the n0 preset.
- **`ib peer id|list|remove`** should not load the addon, because each load
  costs 230–400 ms of wall time in the compiled binary. `list` and `remove`
  only read and write `peers.json`. `id` can derive the public key from
  `secret.key` with `node:crypto`. I checked this against the spike's saved
  key, and it printed the same id the listener reported
  (`1f4a2b41…2085`):

  ```
  $ bun -e "const c=require('node:crypto');const seed=Buffer.from(require('fs').readFileSync(process.argv[1],'utf8').trim(),'hex');const k=c.createPrivateKey({key:Buffer.concat([Buffer.from('302e020100300506032b657004220420','hex'),seed]),format:'der',type:'pkcs8'});console.log(c.createPublicKey(k).export({format:'der',type:'spki'}).subarray(-32).toString('hex'))" /private/tmp/iroh-spike-b/a-listener.key
  1f4a2b41181dd109205c862c3b5114c1cb9dbedb336e0d1c4d450cf7aa202085
  ```

- **Tests.** Use `presetMinimal` + `RelayMode.disabled()` +
  `bindAddr("127.0.0.1:0")`, and dial `new EndpointAddr(id, null,
  ep.addr().directAddresses())`. A round trip takes a few milliseconds.
  Tests run the source under `bun test`, which loads the addon from
  `node_modules`, so `@number0/iroh` must be a root dependency in Phase 1.
- **Binary size.** `ib` grows by about 12.3 MB, from about 71 MB to about
  83 MB.

## Recommendation

**Proceed with in-process N-API.** All five checks pass on Bun 1.3.10 with
`@number0/iroh@1.2.0`:

- Two processes find each other by id alone through n0's relays and
  discovery, and `conn.remoteId()` gives the authenticated peer id that the
  pairing and allowlist designs depend on.
- A plain `import` of `@number0/iroh` embeds the addon into a binary built
  with the exact `ib` flags, including `--bytecode --format=esm`. The binary
  runs from a directory with no `node_modules`. No loader workaround is
  needed.
- Behind a dynamic import, the addon adds about 12.3 MB to the binary and no
  measurable CPU to a path that never loads it. Hooks and the statusline keep
  their start time.
- A relay-disabled loopback on `127.0.0.1` works without relays, so the
  protocol can be tested offline.
- Once `ep.close()` is called, the process exits on its own.

The costs are manageable:

- a byte and error wrapper;
- per-connection error handling in the accept loop;
- non-overlapping dials in the poller;
- an explicit `ep.close()` on shutdown;
- 230–400 ms of wall time to load the addon. That is fine for `ib watch`,
  which loads it once in the background, and avoidable in `ib peer`.

None of this calls for the Rust sidecar fallback.
