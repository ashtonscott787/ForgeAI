//! Real hardware detection.
//!
//! Cross-platform facts (RAM, CPU, core count) come from `sysinfo`. The two
//! things it cannot tell us — which GPU backend is usable and how much VRAM
//! that GPU has — are probed per-OS, and every probe is allowed to fail: an
//! unknown GPU means we fall back to CPU rather than guessing.

use forge_core::hardware::{self, ProbeOverrides};
use forge_core::types::{Backend, MachineCapability};
use std::process::Command;
use sysinfo::System;

/// Ask `nvidia-smi` for total VRAM on the first GPU, in bytes.
/// Returns `None` when the tool is absent or the output is not what we expect.
fn nvidia_vram() -> Option<u64> {
    let out = Command::new("nvidia-smi")
        .args(["--query-gpu=memory.total", "--format=csv,noheader,nounits"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let text = String::from_utf8_lossy(&out.stdout);
    let mib: u64 = text.lines().next()?.trim().parse().ok()?;
    Some(mib * 1024 * 1024)
}

#[cfg(target_os = "macos")]
fn detect() -> ProbeOverrides {
    // Every Mac that can run Forge (macOS 12+) has Metal. Apple Silicon has
    // unified memory; Intel Macs with a discrete GPU do not, but we treat the
    // RAM pool as the budget either way because Metal can address it.
    ProbeOverrides {
        backend: Some(Backend::Metal),
        vram_bytes: None,
        unified_memory: Some(true),
        runtimes: vec![],
    }
}

#[cfg(not(target_os = "macos"))]
fn detect() -> ProbeOverrides {
    match nvidia_vram() {
        Some(vram) => ProbeOverrides {
            backend: Some(Backend::Cuda),
            vram_bytes: Some(vram),
            unified_memory: Some(false),
            runtimes: vec![],
        },
        // No CUDA GPU found. Vulkan would be the next candidate, but we only
        // claim it once we can actually enumerate a device, so: CPU.
        None => ProbeOverrides {
            backend: Some(Backend::Cpu),
            vram_bytes: None,
            unified_memory: Some(false),
            runtimes: vec![],
        },
    }
}

pub fn machine_name() -> String {
    System::host_name().unwrap_or_else(|| "This machine".into())
}

/// Human-readable CPU description, for the setup screen.
pub fn cpu_label() -> String {
    let mut sys = System::new();
    sys.refresh_cpu_all();
    let brand = sys
        .cpus()
        .first()
        .map(|c| c.brand().trim().to_string())
        .unwrap_or_default();
    let n = sys.cpus().len();
    if brand.is_empty() {
        format!("{n} cores")
    } else {
        format!("{brand} · {n} cores")
    }
}

pub fn profile(runtime_id: &str) -> MachineCapability {
    let mut ov = detect();
    ov.runtimes = vec![runtime_id.to_string()];
    hardware::profile(1, machine_name(), ov)
}

/// Free bytes on the volume holding `path`. Used to refuse a download that
/// would not fit, before it starts.
pub fn free_disk_bytes(path: &std::path::Path) -> Option<u64> {
    use sysinfo::Disks;
    let disks = Disks::new_with_refreshed_list();
    let mut best: Option<(usize, u64)> = None;
    for d in disks.list() {
        let mp = d.mount_point();
        if path.starts_with(mp) {
            let depth = mp.components().count();
            if best.is_none_or(|(bd, _)| depth > bd) {
                best = Some((depth, d.available_space()));
            }
        }
    }
    best.map(|(_, free)| free)
}
