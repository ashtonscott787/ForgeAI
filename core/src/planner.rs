//! Placement planning.
//!
//! The whole product constraint lives in this file: **distribution raises the
//! memory ceiling, not the intelligence or speed ceiling.** Splitting a model
//! across machines adds an activation round trip at every layer boundary and
//! runs at the speed of the slowest node and link. So:
//!
//!   1. If it fits on one machine, never split it.
//!   2. If it fits on several, replicate and load-balance.
//!   3. Only split when nothing can hold it alone.
//!   4. Never split over a link we have not measured, or a slow one.
//!
//! Every plan carries its own predicted cost and the best single-machine
//! alternative, so the UI can be honest before the user commits.

use crate::types::*;

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum PlanError {
    #[error("no machine is online and approved")]
    NoMachines,
    #[error("model needs {need} bytes; the whole cluster can hold {have}")]
    TooLarge { need: u64, have: u64 },
    #[error("model needs {need} bytes and no single machine can hold it, but no set of machines is connected by a link fast enough to split over")]
    NoSplittableTopology { need: u64 },
    #[error("runtime {0} is not present on every machine the plan needs")]
    RuntimeMismatch(String),
}

pub struct Planner<'a> {
    pub machines: &'a [MachineCapability],
    pub self_id: u64,
    /// Runtime build id this cluster has agreed on.
    pub runtime_id: &'a str,
}

impl<'a> Planner<'a> {
    pub fn new(machines: &'a [MachineCapability], self_id: u64, runtime_id: &'a str) -> Self {
        Self {
            machines,
            self_id,
            runtime_id,
        }
    }

    fn usable(&self) -> Vec<&MachineCapability> {
        self.machines
            .iter()
            .filter(|m| m.schedulable() && m.runtimes.iter().any(|r| r == self.runtime_id))
            .collect()
    }

    /// Predicted tokens/sec for a model running whole on one machine.
    /// Scaled from the model's reference figure by backend weight and load.
    /// Returns `None` when the model has no reference measurement — we say
    /// "unknown" rather than invent a number.
    pub fn single_tok_s(&self, m: &MachineCapability, req: &ModelRequirement) -> Option<f32> {
        if req.reference_tok_s <= 0.0 {
            return None;
        }
        Some(req.reference_tok_s * m.backend.weight() * (1.0 - m.load.clamp(0.0, 0.9)))
    }

    /// Predicted tokens/sec for a split plan.
    ///
    /// Two penalties, both real:
    ///   * the chain runs at the speed of its slowest member, and
    ///   * every layer boundary costs a round trip on the link that crosses it.
    fn split_tok_s(&self, shards: &[Shard], req: &ModelRequirement) -> f32 {
        let mut slowest = f32::MAX;
        let mut worst_rtt = 0.0f32;

        for s in shards {
            let Some(m) = self.machines.iter().find(|m| m.id == s.machine_id) else {
                continue;
            };
            if let Some(t) = self.single_tok_s(m, req) {
                slowest = slowest.min(t);
            }
            for other in shards.iter().filter(|o| o.machine_id != s.machine_id) {
                if let Some(l) = m.link_to(other.machine_id) {
                    worst_rtt = worst_rtt.max(l.rtt_ms);
                }
            }
        }
        if slowest == f32::MAX {
            return 0.0;
        }

        // Each boundary adds worst_rtt milliseconds to every token.
        let boundaries = shards.len().saturating_sub(1) as f32;
        let base_ms_per_tok = 1000.0 / slowest.max(0.01);
        let total_ms = base_ms_per_tok + boundaries * worst_rtt;
        1000.0 / total_ms.max(0.01)
    }

    pub fn plan(&self, req: &ModelRequirement) -> Result<PlacementPlan, PlanError> {
        let usable = self.usable();
        if usable.is_empty() {
            return Err(PlanError::NoMachines);
        }
        let need = req.total_bytes();

        // Every machine that could hold the whole thing, best compute first.
        let mut holders: Vec<&MachineCapability> = usable
            .iter()
            .copied()
            .filter(|m| m.can_hold(need))
            .collect();
        holders.sort_by(|a, b| {
            let ta = self.single_tok_s(a, req).unwrap_or(0.0);
            let tb = self.single_tok_s(b, req).unwrap_or(0.0);
            tb.partial_cmp(&ta).unwrap_or(std::cmp::Ordering::Equal)
        });

        let best_single_tok_s = holders.first().and_then(|m| self.single_tok_s(m, req));

        // ── Rule 1 & 2: it fits somewhere. Never split.
        if let Some(best) = holders.first() {
            if holders.len() > 1 {
                return Ok(PlacementPlan {
                    placement: Placement::Replicated {
                        machine_ids: holders.iter().map(|m| m.id).collect(),
                    },
                    reason: format!(
                        "{} machines can each hold this model, so Forge runs a full copy on each and balances requests. \
                         Splitting it would be slower.",
                        holders.len()
                    ),
                    predicted_tok_s: best_single_tok_s.unwrap_or(0.0),
                    best_single_tok_s,
                });
            }
            let placement = if best.id == self.self_id {
                Placement::Local {
                    machine_id: best.id,
                }
            } else {
                Placement::Remote {
                    machine_id: best.id,
                }
            };
            return Ok(PlacementPlan {
                placement,
                reason: format!("Fits whole on {}. Nothing to distribute.", best.name),
                predicted_tok_s: best_single_tok_s.unwrap_or(0.0),
                best_single_tok_s,
            });
        }

        // ── Rule 3 & 4: nothing can hold it. Split, but only over fast links.
        let mut candidates: Vec<&MachineCapability> = usable
            .iter()
            .copied()
            .filter(|m| {
                m.id == self.self_id || m.link_to(self.self_id).is_some_and(|l| l.splittable())
            })
            .collect();

        // Largest memory first: fewer boundaries means fewer round trips.
        candidates.sort_by_key(|m| std::cmp::Reverse(m.usable_model_bytes));

        let cluster_capacity: u64 = candidates.iter().map(|m| m.usable_model_bytes).sum();
        if cluster_capacity < need {
            let all: u64 = usable.iter().map(|m| m.usable_model_bytes).sum();
            if all >= need {
                return Err(PlanError::NoSplittableTopology { need });
            }
            return Err(PlanError::TooLarge { need, have: all });
        }

        // Take machines until the model fits, then assign layers in proportion
        // to each machine's usable memory. This mirrors what llama.cpp's RPC
        // backend does on its own; we do it explicitly so we can predict it.
        let mut taken: Vec<&MachineCapability> = Vec::new();
        let mut acc = 0u64;
        for m in candidates {
            taken.push(m);
            acc += m.usable_model_bytes;
            if acc >= need {
                break;
            }
        }

        let total_mem: u64 = taken.iter().map(|m| m.usable_model_bytes).sum();
        let mut shards = Vec::with_capacity(taken.len());
        let mut cursor = 0u32;
        for (i, m) in taken.iter().enumerate() {
            let layers = if i == taken.len() - 1 {
                req.layers.saturating_sub(cursor)
            } else {
                let share = m.usable_model_bytes as f64 / total_mem as f64;
                ((req.layers as f64 * share).round() as u32).max(1)
            };
            let last = (cursor + layers).min(req.layers);
            shards.push(Shard {
                machine_id: m.id,
                first_layer: cursor,
                last_layer: last,
            });
            cursor = last;
        }

        let predicted = self.split_tok_s(&shards, req);
        let names: Vec<&str> = taken.iter().map(|m| m.name.as_str()).collect();

        Ok(PlacementPlan {
            placement: Placement::Split { shards },
            reason: format!(
                "No single machine can hold this model, so its layers are split across {}. \
                 This raises the memory ceiling; it does not make the model faster or smarter.",
                names.join(", ")
            ),
            predicted_tok_s: predicted,
            best_single_tok_s,
        })
    }
}

// ───────────────────────── tests ─────────────────────────
#[cfg(test)]
mod tests {
    use super::*;

    const GB: u64 = 1024 * 1024 * 1024;
    const RT: &str = "llamacpp-b4321";

    fn machine(
        id: u64,
        name: &str,
        usable_gb: u64,
        backend: Backend,
        links: Vec<Link>,
    ) -> MachineCapability {
        MachineCapability {
            schema: MachineCapability::SCHEMA,
            id,
            name: name.into(),
            os: "test".into(),
            backend,
            trust: if id == 1 {
                Trust::SelfHost
            } else {
                Trust::Approved
            },
            ram_bytes: usable_gb * GB * 2,
            vram_bytes: 0,
            unified_memory: true,
            usable_model_bytes: usable_gb * GB,
            runtimes: vec![RT.into()],
            links,
            load: 0.0,
            online: true,
        }
    }

    fn fast(peer: u64) -> Link {
        Link {
            peer_id: peer,
            mbit_s: 9400.0,
            rtt_ms: 0.3,
        }
    }
    fn wan(peer: u64) -> Link {
        Link {
            peer_id: peer,
            mbit_s: 80.0,
            rtt_ms: 48.0,
        }
    }

    fn model(name: &str, gb: u64, layers: u32, tok_s: f32) -> ModelRequirement {
        ModelRequirement {
            id: name.into(),
            name: name.into(),
            weight_bytes: gb * GB,
            kv_bytes: GB,
            layers,
            reference_tok_s: tok_s,
            needs_vision: false,
        }
    }

    #[test]
    fn fits_locally_stays_local() {
        let ms = vec![machine(1, "This Mac", 96, Backend::Metal, vec![])];
        let p = Planner::new(&ms, 1, RT);
        let plan = p.plan(&model("qwen3-8b", 5, 36, 70.0)).unwrap();
        assert!(matches!(plan.placement, Placement::Local { machine_id: 1 }));
        assert!(!plan.is_regression());
    }

    /// The rule that matters most: a model that fits is NEVER split, even when
    /// a cluster is sitting right there.
    #[test]
    fn never_splits_a_model_that_fits() {
        let ms = vec![
            machine(1, "This Mac", 96, Backend::Metal, vec![fast(2)]),
            machine(2, "Studio", 150, Backend::Metal, vec![fast(1)]),
        ];
        let p = Planner::new(&ms, 1, RT);
        let plan = p.plan(&model("llama-70b", 40, 80, 24.0)).unwrap();
        assert!(
            matches!(plan.placement, Placement::Replicated { .. }),
            "expected replication, got {:?}",
            plan.placement
        );
        assert!(plan.reason.contains("Splitting it would be slower"));
    }

    #[test]
    fn splits_only_when_nothing_can_hold_it() {
        let ms = vec![
            machine(1, "This Mac", 96, Backend::Metal, vec![fast(2)]),
            machine(2, "Studio", 150, Backend::Metal, vec![fast(1)]),
        ];
        let p = Planner::new(&ms, 1, RT);
        let plan = p.plan(&model("qwen3-235b", 200, 94, 18.0)).unwrap();
        match &plan.placement {
            Placement::Split { shards } => {
                assert_eq!(shards.len(), 2);
                // every layer assigned exactly once, in order
                assert_eq!(shards[0].first_layer, 0);
                assert_eq!(shards.last().unwrap().last_layer, 94);
                let total: u32 = shards.iter().map(|s| s.layers()).sum();
                assert_eq!(total, 94);
            }
            other => panic!("expected a split, got {other:?}"),
        }
        // Nothing could hold it alone, so there is no single-machine alternative.
        assert_eq!(plan.best_single_tok_s, None);
    }

    /// A WAN peer may be routed to, but must never be split over.
    #[test]
    fn refuses_to_split_over_a_wan_link() {
        let ms = vec![
            machine(1, "This Mac", 96, Backend::Metal, vec![wan(2)]),
            machine(2, "Office NUC", 150, Backend::Cpu, vec![wan(1)]),
        ];
        let p = Planner::new(&ms, 1, RT);
        let err = p.plan(&model("qwen3-235b", 200, 94, 18.0)).unwrap_err();
        assert_eq!(err, PlanError::NoSplittableTopology { need: 201 * GB });
    }

    /// But a model that fits on the far machine is happily sent there whole.
    #[test]
    fn routes_whole_model_over_a_wan_link() {
        let ms = vec![
            machine(1, "Laptop", 8, Backend::Cpu, vec![wan(2)]),
            machine(2, "Workstation", 150, Backend::Cuda, vec![wan(1)]),
        ];
        let p = Planner::new(&ms, 1, RT);
        let plan = p.plan(&model("llama-70b", 40, 80, 24.0)).unwrap();
        assert!(matches!(
            plan.placement,
            Placement::Remote { machine_id: 2 }
        ));
    }

    #[test]
    fn pending_and_offline_peers_are_never_scheduled() {
        let mut pending = machine(2, "Stranger", 500, Backend::Cuda, vec![fast(1)]);
        pending.trust = Trust::Pending;
        let mut offline = machine(3, "Asleep", 500, Backend::Cuda, vec![fast(1)]);
        offline.online = false;
        let ms = vec![
            machine(1, "This Mac", 8, Backend::Metal, vec![fast(2), fast(3)]),
            pending,
            offline,
        ];
        let p = Planner::new(&ms, 1, RT);
        let err = p.plan(&model("qwen3-235b", 200, 94, 18.0)).unwrap_err();
        assert!(matches!(err, PlanError::TooLarge { .. }));
    }

    /// RPC needs byte-identical builds, so a machine on another runtime is
    /// simply not a candidate.
    #[test]
    fn machines_on_a_different_runtime_build_are_excluded() {
        let mut odd = machine(2, "Studio", 150, Backend::Metal, vec![fast(1)]);
        odd.runtimes = vec!["llamacpp-b9999".into()];
        let ms = vec![
            machine(1, "This Mac", 96, Backend::Metal, vec![fast(2)]),
            odd,
        ];
        let p = Planner::new(&ms, 1, RT);
        let plan = p.plan(&model("llama-70b", 40, 80, 24.0)).unwrap();
        assert!(matches!(plan.placement, Placement::Local { machine_id: 1 }));
    }

    /// A split plan must report honestly that it is slower per token than one
    /// machine would be, when that is true.
    #[test]
    fn split_is_slower_per_token_than_a_single_machine() {
        let ms = vec![
            machine(1, "A", 30, Backend::Metal, vec![fast(2)]),
            machine(2, "B", 30, Backend::Metal, vec![fast(1)]),
        ];
        let p = Planner::new(&ms, 1, RT);
        let req = model("mid", 50, 60, 40.0);
        let plan = p.plan(&req).unwrap();
        assert!(matches!(plan.placement, Placement::Split { .. }));
        let solo = p.single_tok_s(&ms[0], &req).unwrap();
        assert!(
            plan.predicted_tok_s < solo,
            "split {} should be slower than solo {}",
            plan.predicted_tok_s,
            solo
        );
    }

    #[test]
    fn unknown_reference_speed_yields_no_prediction_rather_than_a_guess() {
        let ms = vec![machine(1, "This Mac", 96, Backend::Metal, vec![])];
        let p = Planner::new(&ms, 1, RT);
        let plan = p.plan(&model("mystery", 5, 36, 0.0)).unwrap();
        assert_eq!(plan.best_single_tok_s, None);
    }

    #[test]
    fn empty_cluster_is_an_error_not_a_panic() {
        let ms: Vec<MachineCapability> = vec![];
        let p = Planner::new(&ms, 1, RT);
        assert_eq!(
            p.plan(&model("x", 1, 1, 1.0)).unwrap_err(),
            PlanError::NoMachines
        );
    }
}
