//! Hardware profiling. Produces exactly one `MachineCapability`.
//!
//! The headroom policy is the only judgement call here and it is deliberately
//! conservative: a machine that fills its memory with weights swaps, and a
//! swapping machine feels broken.

use crate::types::*;
use sysinfo::System;

/// Fraction of memory we are willing to fill with model weights.
/// Unified-memory machines share this pool with the OS and the display, so they
/// get less. Discrete VRAM is ours alone, so it gets more.
const UNIFIED_HEADROOM: f64 = 0.75;
const DISCRETE_HEADROOM: f64 = 0.92;
/// Never promise more than this much less than the machine physically has.
const MIN_RESERVE_BYTES: u64 = 3 * 1024 * 1024 * 1024;

#[derive(Debug, Clone, Default)]
pub struct ProbeOverrides {
    /// Set when a GPU probe (nvml / Metal / Vulkan) has run. `None` means we
    /// could not detect a GPU and fall back to CPU.
    pub backend: Option<Backend>,
    pub vram_bytes: Option<u64>,
    pub unified_memory: Option<bool>,
    pub runtimes: Vec<String>,
}

/// Probe this machine. Pure apart from reading the system — the GPU specifics
/// arrive as overrides from the platform layer, so this stays testable.
pub fn profile(id: u64, name: impl Into<String>, ov: ProbeOverrides) -> MachineCapability {
    let mut sys = System::new();
    sys.refresh_memory();
    sys.refresh_cpu_usage();

    let ram_bytes = sys.total_memory();
    let backend = ov.backend.unwrap_or(Backend::Cpu);
    let unified = ov
        .unified_memory
        .unwrap_or(matches!(backend, Backend::Metal));
    let vram_bytes = ov.vram_bytes.unwrap_or(0);

    let usable_model_bytes = usable_bytes(ram_bytes, vram_bytes, unified);

    MachineCapability {
        schema: MachineCapability::SCHEMA,
        id,
        name: name.into(),
        os: format!(
            "{} {}",
            System::name().unwrap_or_default(),
            System::os_version().unwrap_or_default()
        )
        .trim()
        .to_string(),
        backend,
        trust: Trust::SelfHost,
        ram_bytes,
        vram_bytes,
        unified_memory: unified,
        usable_model_bytes,
        runtimes: ov.runtimes,
        links: Vec::new(),
        load: 0.0,
        online: true,
    }
}

/// How many bytes of weights this machine can honestly hold.
pub fn usable_bytes(ram_bytes: u64, vram_bytes: u64, unified: bool) -> u64 {
    let pool = if unified || vram_bytes == 0 {
        ram_bytes
    } else {
        vram_bytes
    };
    let headroom = if unified || vram_bytes == 0 {
        UNIFIED_HEADROOM
    } else {
        DISCRETE_HEADROOM
    };
    let by_fraction = (pool as f64 * headroom) as u64;
    let by_reserve = pool.saturating_sub(MIN_RESERVE_BYTES);
    by_fraction.min(by_reserve)
}

#[cfg(test)]
mod tests {
    use super::*;
    const GB: u64 = 1024 * 1024 * 1024;

    #[test]
    fn unified_memory_keeps_real_headroom() {
        // 128 GB Mac should not promise anything near 128 GB.
        let u = usable_bytes(128 * GB, 0, true);
        assert!(u < 100 * GB, "promised {u} bytes");
        assert!(u > 80 * GB, "too conservative: {u} bytes");
    }

    #[test]
    fn discrete_vram_uses_vram_not_ram() {
        // 32 GB card in a 128 GB box: the card is the constraint.
        let u = usable_bytes(128 * GB, 32 * GB, false);
        assert!(u < 32 * GB);
        assert!(u > 24 * GB);
    }

    #[test]
    fn tiny_machines_never_report_negative_or_absurd_capacity() {
        assert_eq!(usable_bytes(2 * GB, 0, true), 0);
        assert!(usable_bytes(8 * GB, 0, true) <= 5 * GB);
    }

    #[test]
    fn profile_is_self_trusted_and_online() {
        let m = profile(1, "test", ProbeOverrides::default());
        assert_eq!(m.trust, Trust::SelfHost);
        assert!(m.online);
        assert_eq!(m.schema, MachineCapability::SCHEMA);
    }
}
