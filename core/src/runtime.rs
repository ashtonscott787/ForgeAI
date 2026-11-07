//! Runtime supervision: turning a `Placement` into actual llama.cpp processes.
//!
//! This module builds argument vectors and nothing else — spawning lives in the
//! platform layer. Keeping it pure means the argument construction, which is
//! where the real bugs hide, is unit-testable.

use crate::types::*;
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum RuntimeError {
    #[error("placement names machine {0}, which is not in the cluster")]
    UnknownMachine(u64),
    #[error("a split placement needs at least two shards")]
    DegenerateSplit,
    #[error("shards do not cover layers 0..{expected} exactly")]
    BadLayerCoverage { expected: u32 },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerSpec {
    /// Arguments for the coordinating `llama-server`.
    pub args: Vec<String>,
    /// `rpc-server` endpoints this coordinator should dial, in layer order.
    pub rpc_endpoints: Vec<String>,
    pub port: u16,
}

#[derive(Debug, Clone)]
pub struct RuntimeConfig {
    pub model_path: String,
    pub context: u32,
    pub port: u16,
    /// Number of layers to offload to the GPU. 999 means "all of them".
    pub gpu_layers: u32,
    pub threads: Option<u32>,
}

/// Validate that a split plan actually covers every layer exactly once.
/// A gap or an overlap here produces garbage output, not an error, so it is
/// checked before anything is spawned.
pub fn validate(placement: &Placement, layers: u32) -> Result<(), RuntimeError> {
    if let Placement::Split { shards } = placement {
        if shards.len() < 2 {
            return Err(RuntimeError::DegenerateSplit);
        }
        let mut cursor = 0u32;
        for s in shards {
            if s.first_layer != cursor || s.last_layer <= s.first_layer {
                return Err(RuntimeError::BadLayerCoverage { expected: layers });
            }
            cursor = s.last_layer;
        }
        if cursor != layers {
            return Err(RuntimeError::BadLayerCoverage { expected: layers });
        }
    }
    Ok(())
}

/// Build the coordinator's command line for a given placement.
pub fn server_spec(
    placement: &Placement,
    cfg: &RuntimeConfig,
    machines: &[MachineCapability],
    rpc_port: u16,
) -> Result<ServerSpec, RuntimeError> {
    let addr_of = |id: u64| -> Result<String, RuntimeError> {
        machines
            .iter()
            .find(|m| m.id == id)
            .map(|m| format!("{}:{}", mesh_host(m), rpc_port))
            .ok_or(RuntimeError::UnknownMachine(id))
    };

    let mut args = vec![
        "--model".into(),
        cfg.model_path.clone(),
        "--ctx-size".into(),
        cfg.context.to_string(),
        "--port".into(),
        cfg.port.to_string(),
        // Bind to loopback only. The mesh carries everything between machines;
        // the HTTP surface is never exposed to a raw network.
        "--host".into(),
        "127.0.0.1".into(),
        "--n-gpu-layers".into(),
        cfg.gpu_layers.to_string(),
    ];
    if let Some(t) = cfg.threads {
        args.push("--threads".into());
        args.push(t.to_string());
    }

    let rpc_endpoints = match placement {
        Placement::Local { .. } => Vec::new(),
        Placement::Remote { machine_id } => vec![addr_of(*machine_id)?],
        Placement::Replicated { .. } => Vec::new(),
        Placement::Split { shards } => {
            let mut v = Vec::with_capacity(shards.len());
            for s in shards {
                v.push(addr_of(s.machine_id)?);
            }
            v
        }
    };

    if !rpc_endpoints.is_empty() {
        args.push("--rpc".into());
        args.push(rpc_endpoints.join(","));
    }

    Ok(ServerSpec {
        args,
        rpc_endpoints,
        port: cfg.port,
    })
}

/// Hostname a peer is reachable at over the mesh. The mesh assigns these, so
/// nothing here depends on the physical network.
pub fn mesh_host(m: &MachineCapability) -> String {
    format!("{}.forge.internal", m.name.to_lowercase().replace(' ', "-"))
}

#[cfg(test)]
mod tests {
    use super::*;
    const GB: u64 = 1024 * 1024 * 1024;

    fn m(id: u64, name: &str) -> MachineCapability {
        MachineCapability {
            schema: 1,
            id,
            name: name.into(),
            os: "t".into(),
            backend: Backend::Metal,
            trust: Trust::Approved,
            ram_bytes: 64 * GB,
            vram_bytes: 0,
            unified_memory: true,
            usable_model_bytes: 40 * GB,
            runtimes: vec!["r".into()],
            links: vec![],
            load: 0.0,
            online: true,
        }
    }
    fn cfg() -> RuntimeConfig {
        RuntimeConfig {
            model_path: "/m.gguf".into(),
            context: 8192,
            port: 8730,
            gpu_layers: 999,
            threads: None,
        }
    }

    #[test]
    fn local_placement_needs_no_rpc_flag() {
        let s = server_spec(
            &Placement::Local { machine_id: 1 },
            &cfg(),
            &[m(1, "a")],
            50052,
        )
        .unwrap();
        assert!(!s.args.contains(&"--rpc".to_string()));
    }

    #[test]
    fn split_placement_dials_every_shard_in_layer_order() {
        let ms = vec![m(1, "This Mac"), m(2, "Studio")];
        let p = Placement::Split {
            shards: vec![
                Shard {
                    machine_id: 1,
                    first_layer: 0,
                    last_layer: 40,
                },
                Shard {
                    machine_id: 2,
                    first_layer: 40,
                    last_layer: 80,
                },
            ],
        };
        let s = server_spec(&p, &cfg(), &ms, 50052).unwrap();
        assert_eq!(
            s.rpc_endpoints,
            vec![
                "this-mac.forge.internal:50052",
                "studio.forge.internal:50052"
            ]
        );
        let i = s.args.iter().position(|a| a == "--rpc").unwrap();
        assert!(s.args[i + 1].contains(','));
    }

    #[test]
    fn http_surface_is_always_loopback_only() {
        let s = server_spec(
            &Placement::Local { machine_id: 1 },
            &cfg(),
            &[m(1, "a")],
            50052,
        )
        .unwrap();
        let i = s.args.iter().position(|a| a == "--host").unwrap();
        assert_eq!(s.args[i + 1], "127.0.0.1");
    }

    #[test]
    fn unknown_machine_is_rejected_before_spawning() {
        let p = Placement::Remote { machine_id: 42 };
        assert_eq!(
            server_spec(&p, &cfg(), &[m(1, "a")], 50052).unwrap_err(),
            RuntimeError::UnknownMachine(42)
        );
    }

    #[test]
    fn layer_gaps_and_overlaps_are_caught() {
        let gap = Placement::Split {
            shards: vec![
                Shard {
                    machine_id: 1,
                    first_layer: 0,
                    last_layer: 30,
                },
                Shard {
                    machine_id: 2,
                    first_layer: 40,
                    last_layer: 80,
                },
            ],
        };
        assert!(validate(&gap, 80).is_err());

        let short = Placement::Split {
            shards: vec![
                Shard {
                    machine_id: 1,
                    first_layer: 0,
                    last_layer: 30,
                },
                Shard {
                    machine_id: 2,
                    first_layer: 30,
                    last_layer: 60,
                },
            ],
        };
        assert!(validate(&short, 80).is_err());

        let good = Placement::Split {
            shards: vec![
                Shard {
                    machine_id: 1,
                    first_layer: 0,
                    last_layer: 40,
                },
                Shard {
                    machine_id: 2,
                    first_layer: 40,
                    last_layer: 80,
                },
            ],
        };
        assert!(validate(&good, 80).is_ok());
    }

    #[test]
    fn a_single_shard_split_is_rejected() {
        let p = Placement::Split {
            shards: vec![Shard {
                machine_id: 1,
                first_layer: 0,
                last_layer: 80,
            }],
        };
        assert_eq!(validate(&p, 80).unwrap_err(), RuntimeError::DegenerateSplit);
    }
}
