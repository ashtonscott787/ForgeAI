//! # forge-core
//!
//! Forge AI's domain logic, with no UI and no Tauri dependency, so it compiles
//! and tests on any platform including CI runners without a desktop toolchain.
//!
//! Module boundaries, which are the point:
//!
//! * [`types`]    — `MachineCapability` and `Placement`, the two contracts.
//! * [`hardware`] — produces one `MachineCapability` for this machine.
//! * [`registry`] — catalogue, download sizing, quantization choice, recommendation.
//! * [`planner`]  — turns a model requirement plus a cluster into a `PlacementPlan`.
//! * [`runtime`]  — turns a `Placement` into llama.cpp arguments.
//!
//! The UI never talks to a runtime or a peer directly. It asks the gateway,
//! which asks the planner. That one boundary is what let clustering be added
//! without rewriting the chat app.

pub mod hardware;
pub mod planner;
pub mod registry;
pub mod runtime;
pub mod types;

pub use planner::{PlanError, Planner};
pub use types::*;
