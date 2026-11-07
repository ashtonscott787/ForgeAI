# sidecar/mesh — not wired into the app

`mesh/main.go` is a working design for the networking sidecar: an embedded
Tailscale node (`tsnet`) that joins a mesh from inside the process, with no
driver, no system daemon and no admin install.

**It is not part of the 0.1 build.** It has never been compiled or run, and the
app does not launch it. It is kept here because the design is sound and it is
where distributed inference will plug in — not because it works today.

Before it can ship:

1. `cd mesh && go mod tidy && go build .` — generate `go.sum` and confirm it
   compiles against the real `tailscale.com` module.
2. Wire it into `src-tauri` as an `externalBin` and have the Rust side read its
   line-delimited JSON events.
3. Test a two-machine split end to end, on a real LAN, and measure it.
4. Only then flip `distributed_inference_enabled` in `src-tauri/src/cluster.rs`.

Until step 4, `cluster.rs` reports distributed inference as off, which is the
truth.
