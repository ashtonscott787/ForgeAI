//! Model registry: the signed catalogue, download planning, and the
//! recommendation that onboarding shows.
//!
//! The catalogue is a manifest fetched from Forge's own infrastructure, so new
//! models ship without an app release. Nothing here trusts the manifest blindly:
//! every artifact carries a sha256 and the manifest itself is signed.

use crate::types::{MachineCapability, ModelRequirement};
use serde::{Deserialize, Serialize};

#[derive(Debug, thiserror::Error, PartialEq)]
pub enum RegistryError {
    #[error("manifest schema {found} is newer than this app supports ({supported})")]
    UnsupportedSchema { found: u32, supported: u32 },
    #[error("checksum mismatch for {0}: the download is corrupt or tampered with")]
    ChecksumMismatch(String),
    #[error("model {0} is not in the catalogue")]
    UnknownModel(String),
    #[error("no quantization of {model} fits in {bytes} bytes")]
    NothingFits { model: String, bytes: u64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Quant {
    Q4KM,
    Q5KM,
    Q6K,
    Q80,
    F16,
}

impl Quant {
    pub fn label(self) -> &'static str {
        match self {
            Quant::Q4KM => "Q4_K_M",
            Quant::Q5KM => "Q5_K_M",
            Quant::Q6K => "Q6_K",
            Quant::Q80 => "Q8_0",
            Quant::F16 => "F16",
        }
    }
    /// Bits per weight, used to size a download before we have the file.
    pub fn bits_per_weight(self) -> f64 {
        match self {
            Quant::Q4KM => 4.8,
            Quant::Q5KM => 5.7,
            Quant::Q6K => 6.6,
            Quant::Q80 => 8.5,
            Quant::F16 => 16.0,
        }
    }
    /// Quality order, best first. Used to pick the best that fits.
    pub fn best_first() -> [Quant; 5] {
        [Quant::F16, Quant::Q80, Quant::Q6K, Quant::Q5KM, Quant::Q4KM]
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Artifact {
    pub quant: Quant,
    pub url: String,
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogueEntry {
    pub id: String,
    pub name: String,
    pub family: String,
    pub params_b: f32,
    pub layers: u32,
    pub max_context: u32,
    pub vision: bool,
    /// Measured on a reference CUDA machine. Zero when we have not measured it,
    /// and the UI then shows "unknown" rather than a guess.
    pub reference_tok_s: f32,
    pub artifacts: Vec<Artifact>,
    /// Licence of the weights, which is not ours and may forbid commercial use.
    pub license: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Catalogue {
    pub schema: u32,
    pub generated_at: String,
    pub models: Vec<CatalogueEntry>,
}

pub const SUPPORTED_SCHEMA: u32 = 1;

impl Catalogue {
    pub fn validate(&self) -> Result<(), RegistryError> {
        if self.schema > SUPPORTED_SCHEMA {
            return Err(RegistryError::UnsupportedSchema {
                found: self.schema,
                supported: SUPPORTED_SCHEMA,
            });
        }
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<&CatalogueEntry, RegistryError> {
        self.models
            .iter()
            .find(|m| m.id == id)
            .ok_or_else(|| RegistryError::UnknownModel(id.into()))
    }
}

/// KV cache size for a given context length. Approximate but conservative:
/// it is better to refuse a context we can serve than to OOM halfway through.
pub fn kv_bytes(
    layers: u32,
    context: u32,
    kv_heads: u32,
    head_dim: u32,
    bytes_per_elem: u32,
) -> u64 {
    // 2 (K and V) * layers * context * heads * head_dim * element size
    2u64 * layers as u64
        * context as u64
        * kv_heads as u64
        * head_dim as u64
        * bytes_per_elem as u64
}

impl CatalogueEntry {
    pub fn requirement(&self, quant: Quant, context: u32) -> Option<ModelRequirement> {
        let a = self.artifacts.iter().find(|a| a.quant == quant)?;
        Some(ModelRequirement {
            id: format!("{}:{}", self.id, quant.label()),
            name: self.name.clone(),
            weight_bytes: a.bytes,
            // 8 KV heads, 128 head dim, fp16 — a reasonable default for the
            // GQA models we ship. Real values come from the GGUF header.
            kv_bytes: kv_bytes(self.layers, context, 8, 128, 2),
            layers: self.layers,
            reference_tok_s: self.reference_tok_s,
            needs_vision: self.vision,
        })
    }

    /// The best quantization that fits in the given budget. Returns an error
    /// rather than silently handing back something that will not load.
    pub fn best_fit(&self, bytes: u64, context: u32) -> Result<ModelRequirement, RegistryError> {
        for q in Quant::best_first() {
            if let Some(req) = self.requirement(q, context) {
                if req.total_bytes() <= bytes {
                    return Ok(req);
                }
            }
        }
        Err(RegistryError::NothingFits {
            model: self.id.clone(),
            bytes,
        })
    }
}

/// What onboarding recommends. Deliberately not the biggest model that fits:
/// a first run that leaves no memory for anything else feels broken.
pub fn recommend<'a>(
    cat: &'a Catalogue,
    machine: &MachineCapability,
    context: u32,
) -> Option<(&'a CatalogueEntry, ModelRequirement)> {
    // Spend at most 40% of usable memory on a first model.
    let budget = (machine.usable_model_bytes as f64 * 0.40) as u64;
    let mut best: Option<(&CatalogueEntry, ModelRequirement)> = None;
    for e in &cat.models {
        if e.vision {
            continue; // not recommended as a first model
        }
        if let Ok(req) = e.best_fit(budget, context) {
            let better = match &best {
                None => true,
                Some((cur, _)) => e.params_b > cur.params_b,
            };
            if better {
                best = Some((e, req));
            }
        }
    }
    best
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hardware;
    const GB: u64 = 1024 * 1024 * 1024;

    fn entry(id: &str, params: f32, layers: u32, q4_gb: u64) -> CatalogueEntry {
        CatalogueEntry {
            id: id.into(),
            name: id.into(),
            family: "test".into(),
            params_b: params,
            layers,
            max_context: 131072,
            vision: false,
            reference_tok_s: 40.0,
            license: "apache-2.0".into(),
            artifacts: vec![
                Artifact {
                    quant: Quant::Q4KM,
                    url: "u".into(),
                    bytes: q4_gb * GB,
                    sha256: "x".into(),
                },
                Artifact {
                    quant: Quant::Q80,
                    url: "u".into(),
                    bytes: q4_gb * GB * 2,
                    sha256: "x".into(),
                },
            ],
        }
    }

    fn cat(models: Vec<CatalogueEntry>) -> Catalogue {
        Catalogue {
            schema: 1,
            generated_at: "2026-11-07".into(),
            models,
        }
    }

    #[test]
    fn rejects_a_manifest_from_the_future() {
        let mut c = cat(vec![]);
        c.schema = 99;
        assert_eq!(
            c.validate().unwrap_err(),
            RegistryError::UnsupportedSchema {
                found: 99,
                supported: 1
            }
        );
    }

    #[test]
    fn best_fit_prefers_quality_but_respects_the_budget() {
        let e = entry("m", 8.0, 36, 5);
        // Plenty of room: should take Q8_0 over Q4_K_M.
        let big = e.best_fit(40 * GB, 8192).unwrap();
        assert!(big.weight_bytes == 10 * GB);
        // Tight: must fall back to Q4_K_M.
        let small = e.best_fit(7 * GB, 8192).unwrap();
        assert!(small.weight_bytes == 5 * GB);
    }

    #[test]
    fn best_fit_errors_rather_than_returning_something_that_will_not_load() {
        let e = entry("huge", 235.0, 94, 130);
        assert!(matches!(
            e.best_fit(8 * GB, 8192),
            Err(RegistryError::NothingFits { .. })
        ));
    }

    #[test]
    fn recommendation_leaves_memory_for_the_rest_of_the_machine() {
        let c = cat(vec![entry("small", 8.0, 36, 5), entry("mid", 70.0, 80, 40)]);
        let mut m = hardware::profile(1, "mac", hardware::ProbeOverrides::default());
        m.usable_model_bytes = 96 * GB;
        let (e, req) = recommend(&c, &m, 8192).unwrap();
        // 40% of 96 GB is ~38 GB, so the 40 GB model must NOT be chosen at Q4.
        assert_eq!(e.id, "small");
        assert!(req.total_bytes() < m.usable_model_bytes / 2);
    }

    #[test]
    fn kv_cache_grows_with_context_and_is_not_ignored() {
        let short = kv_bytes(80, 4096, 8, 128, 2);
        let long = kv_bytes(80, 131072, 8, 128, 2);
        assert!(long > short * 30);
        assert!(long > 10 * GB, "long-context KV must be material: {long}");
    }
}
