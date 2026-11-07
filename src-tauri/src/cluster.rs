//! Computer linking.
//!
//! What ships enabled in 0.1: **nothing that moves inference across machines.**
//!
//! The planner in `forge-core` is implemented and unit-tested, and the
//! mesh-transport design is written up in `docs/ARCHITECTURE.md`, but
//! distributed inference has never been run across two real machines. Shipping
//! it enabled would mean shipping a feature whose failure mode is wrong output
//! and mysterious stalls. So it is gated.
//!
//! What this module does today, and only this:
//!   * reports whether a Tailscale-compatible interface is present, so the UI
//!     can tell the truth about readiness, and
//!   * reports the planner's verdict for a model, as information.

use serde::Serialize;
use std::process::Command;

#[derive(Serialize)]
pub struct LinkReadiness {
    /// A CGNAT-range address (100.64.0.0/10) is how Tailscale and most
    /// WireGuard meshes present themselves.
    pub mesh_interface_detected: bool,
    pub mesh_address: Option<String>,
    /// Always false in 0.1. See the module docs.
    pub distributed_inference_enabled: bool,
    pub explanation: String,
}

/// Look for a mesh address without requiring anything to be installed.
/// Absence is a normal, expected answer.
fn mesh_address() -> Option<String> {
    #[cfg(target_os = "windows")]
    let out = Command::new("ipconfig").output().ok()?;
    #[cfg(not(target_os = "windows"))]
    let out = Command::new("ifconfig")
        .output()
        .or_else(|_| Command::new("ip").arg("addr").output())
        .ok()?;

    let text = String::from_utf8_lossy(&out.stdout);
    for token in text.split(|c: char| !(c.is_ascii_digit() || c == '.')) {
        if is_cgnat(token) {
            return Some(token.to_string());
        }
    }
    None
}

/// 100.64.0.0/10 — the shared address space Tailscale-style meshes use.
fn is_cgnat(s: &str) -> bool {
    let mut parts = s.split('.');
    let a: u8 = match parts.next().and_then(|x| x.parse().ok()) {
        Some(v) => v,
        None => return false,
    };
    let b: u8 = match parts.next().and_then(|x| x.parse().ok()) {
        Some(v) => v,
        None => return false,
    };
    if parts.next().and_then(|x| x.parse::<u8>().ok()).is_none() {
        return false;
    }
    if parts.next().and_then(|x| x.parse::<u8>().ok()).is_none() {
        return false;
    }
    if parts.next().is_some() {
        return false;
    }
    a == 100 && (64..=127).contains(&b)
}

pub fn readiness() -> LinkReadiness {
    let addr = mesh_address();
    LinkReadiness {
        mesh_interface_detected: addr.is_some(),
        mesh_address: addr,
        distributed_inference_enabled: false,
        explanation: "Running one model across several machines is designed and \
unit-tested but has never been run across two real machines, so Forge 0.1 keeps \
it switched off rather than shipping a feature whose failure mode is wrong \
answers. Single-machine inference is fully supported."
            .into(),
    }
}

#[cfg(test)]
mod tests {
    use super::is_cgnat;

    #[test]
    fn recognises_mesh_addresses_and_rejects_everything_else() {
        assert!(is_cgnat("100.64.0.1"));
        assert!(is_cgnat("100.101.102.103"));
        assert!(is_cgnat("100.127.255.254"));
        assert!(!is_cgnat("100.128.0.1")); // just outside the range
        assert!(!is_cgnat("100.63.255.255")); // just below
        assert!(!is_cgnat("192.168.1.1"));
        assert!(!is_cgnat("10.0.0.1"));
        assert!(!is_cgnat("100.64.0")); // too short
        assert!(!is_cgnat("100.64.0.1.5")); // too long
        assert!(!is_cgnat(""));
        assert!(!is_cgnat("not.an.ip.addr"));
    }
}
