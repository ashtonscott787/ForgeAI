//! The two contracts everything else bends around.
//!
//! `MachineCapability` is the ONLY thing the planner sees about a machine.
//! `Placement` is the ONLY thing the runtime manager accepts.
//! Adding NPUs, new GPUs or a cloud burst node later means extending these,
//! not rewriting the scheduler.

use serde::{Deserialize, Serialize};

/// Which inference backend a machine can actually use.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Backend {
    Metal,
    Cuda,
    Vulkan,
    Cpu,
}

impl Backend {
    /// Rough relative compute weight, used only to order candidates.
    /// Not a benchmark — real numbers come from measurement.
    pub fn weight(self) -> f32 {
        match self {
            Backend::Cuda => 1.0,
            Backend::Metal => 0.85,
            Backend::Vulkan => 0.55,
            Backend::Cpu => 0.12,
        }
    }
}

/// How much we trust a peer to run our work.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Trust {
    /// This machine, running this process.
    SelfHost,
    /// Enrolled and approved by the user.
    Approved,
    /// Seen on the mesh but not yet approved. Never scheduled onto.
    Pending,
}

/// A measured link between two machines. Bandwidth and RTT are MEASURED,
/// never assumed — the planner refuses to split over an unmeasured link.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct Link {
    pub peer_id: u64,
    pub mbit_s: f32,
    pub rtt_ms: f32,
}

impl Link {
    /// Splitting a model across a link means an activation round trip at every
    /// layer boundary. Over a WAN that dominates everything else, so we refuse.
    ///
    /// The thresholds are deliberately conservative and deliberately visible:
    /// they are product policy, not physics.
    pub fn splittable(&self) -> bool {
        self.mbit_s >= 500.0 && self.rtt_ms <= 5.0
    }
}

/// One versioned record per machine. The planner sees nothing else.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MachineCapability {
    pub schema: u32,
    pub id: u64,
    pub name: String,
    pub os: String,
    pub backend: Backend,
    pub trust: Trust,
    /// Physical RAM in bytes.
    pub ram_bytes: u64,
    /// Dedicated VRAM in bytes. Zero on unified-memory machines.
    pub vram_bytes: u64,
    /// True on Apple Silicon and similar, where RAM and VRAM are the same pool.
    pub unified_memory: bool,
    /// Bytes we are willing to fill with model weights, after headroom.
    pub usable_model_bytes: u64,
    /// Runtime build ids this machine has. RPC requires byte-identical builds,
    /// so this is part of cluster identity.
    pub runtimes: Vec<String>,
    pub links: Vec<Link>,
    /// 0.0 - 1.0 current load. Loaded machines get deprioritised.
    pub load: f32,
    pub online: bool,
}

impl MachineCapability {
    pub const SCHEMA: u32 = 1;

    pub fn schedulable(&self) -> bool {
        self.online && matches!(self.trust, Trust::SelfHost | Trust::Approved)
    }

    pub fn can_hold(&self, bytes: u64) -> bool {
        self.usable_model_bytes >= bytes
    }

    pub fn link_to(&self, peer_id: u64) -> Option<&Link> {
        self.links.iter().find(|l| l.peer_id == peer_id)
    }
}

/// A contiguous range of transformer layers assigned to one machine.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Shard {
    pub machine_id: u64,
    pub first_layer: u32,
    /// Exclusive.
    pub last_layer: u32,
}

impl Shard {
    pub fn layers(&self) -> u32 {
        self.last_layer.saturating_sub(self.first_layer)
    }
}

/// What the runtime manager is asked to make real.
///
/// Adding tensor-parallel later is a new variant here, not a new architecture.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Placement {
    /// Runs in this process's own runtime.
    Local { machine_id: u64 },
    /// Runs whole on one remote machine. Works over any link, including a WAN.
    Remote { machine_id: u64 },
    /// One model's layers split across machines. LAN or direct link only.
    Split { shards: Vec<Shard> },
    /// N machines each holding a full copy, load-balanced. The right answer
    /// whenever the model already fits — faster than splitting, always.
    Replicated { machine_ids: Vec<u64> },
}

/// Why the planner chose what it chose, and what it will cost.
/// This is what the pre-flight panel in the UI renders. It exists so the
/// product never silently hands someone a slower experience.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PlacementPlan {
    pub placement: Placement,
    pub reason: String,
    /// Our predicted tokens/sec for this plan.
    pub predicted_tok_s: f32,
    /// Best tokens/sec achievable on a single machine, if any single machine
    /// can run this model at all. `None` means the cluster is the only option —
    /// which is the honest case for distribution.
    pub best_single_tok_s: Option<f32>,
}

impl PlacementPlan {
    /// True when distributing is strictly worse than staying on one machine.
    /// The UI uses this to warn rather than to block.
    pub fn is_regression(&self) -> bool {
        matches!(self.placement, Placement::Split { .. })
            && self
                .best_single_tok_s
                .is_some_and(|s| s > self.predicted_tok_s)
    }
}

/// What a model needs in order to run.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelRequirement {
    pub id: String,
    pub name: String,
    /// Weight bytes at the chosen quantization.
    pub weight_bytes: u64,
    /// KV cache bytes at the requested context length.
    pub kv_bytes: u64,
    pub layers: u32,
    /// Measured tokens/sec on a reference CUDA machine, used as the base for
    /// scaling. Zero means unknown, and the planner says so instead of guessing.
    pub reference_tok_s: f32,
    pub needs_vision: bool,
}

impl ModelRequirement {
    pub fn total_bytes(&self) -> u64 {
        self.weight_bytes.saturating_add(self.kv_bytes)
    }
}
