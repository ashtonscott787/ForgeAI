//! Model downloads: resumable, checksum-verified, progress-reporting.
//!
//! Nothing is trusted. A partial file is written to `<name>.part` and only
//! renamed into place once its sha256 matches the manifest. A mismatch deletes
//! the file rather than leaving something that will load as garbage.

use futures_util::StreamExt;
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::PathBuf;
use tauri::{AppHandle, Emitter};
use tokio::io::AsyncWriteExt;

#[derive(Debug, thiserror::Error)]
pub enum DownloadError {
    #[error("network error: {0}")]
    Http(#[from] reqwest::Error),
    #[error("disk error: {0}")]
    Io(#[from] std::io::Error),
    #[error("server returned {0}")]
    Status(u16),
    #[error("not enough free disk space: need {need} bytes, {free} available")]
    NoSpace { need: u64, free: u64 },
    #[error("checksum mismatch: expected {expected}, got {actual}. The file was deleted.")]
    Checksum { expected: String, actual: String },
}

impl serde::Serialize for DownloadError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

#[derive(Clone, Serialize)]
pub struct Progress {
    pub model_id: String,
    pub received: u64,
    pub total: u64,
    pub bytes_per_sec: u64,
    pub done: bool,
}

/// Download `url` into the models directory as `file_name`, verifying `sha256`.
/// Emits `download://progress` events roughly four times a second.
///
/// `sha256` may be empty, in which case verification is SKIPPED and that fact
/// is logged loudly — used only for local testing, never for the shipped
/// catalogue, whose entries always carry a digest.
pub async fn fetch(
    app: AppHandle,
    model_id: String,
    url: String,
    file_name: String,
    sha256: String,
) -> Result<PathBuf, DownloadError> {
    let dir = crate::paths::models_dir();
    tokio::fs::create_dir_all(&dir).await?;
    let final_path = dir.join(&file_name);
    let part_path = dir.join(format!("{file_name}.part"));

    if final_path.is_file() {
        return Ok(final_path);
    }

    let client = reqwest::Client::builder()
        .user_agent(concat!("ForgeAI/", env!("CARGO_PKG_VERSION")))
        .build()?;

    // Resume if a partial file is already there.
    let existing = tokio::fs::metadata(&part_path)
        .await
        .map(|m| m.len())
        .unwrap_or(0);
    let mut req = client.get(&url);
    if existing > 0 {
        req = req.header(reqwest::header::RANGE, format!("bytes={existing}-"));
    }
    let resp = req.send().await?;
    let status = resp.status();
    if !status.is_success() && status.as_u16() != 206 {
        return Err(DownloadError::Status(status.as_u16()));
    }
    let remaining = resp.content_length().unwrap_or(0);
    let total = existing + remaining;

    if let Some(free) = crate::hw::free_disk_bytes(&dir) {
        if free < remaining {
            return Err(DownloadError::NoSpace {
                need: remaining,
                free,
            });
        }
    }

    // Hash the bytes already on disk so a resumed download still verifies.
    let mut hasher = Sha256::new();
    if existing > 0 {
        let prior = tokio::fs::read(&part_path).await?;
        hasher.update(&prior);
    }

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&part_path)
        .await?;

    let mut received = existing;
    let mut stream = resp.bytes_stream();
    let started = std::time::Instant::now();
    let mut last_emit = std::time::Instant::now();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        file.write_all(&chunk).await?;
        hasher.update(&chunk);
        received += chunk.len() as u64;

        if last_emit.elapsed().as_millis() > 250 {
            last_emit = std::time::Instant::now();
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            let _ = app.emit(
                "download://progress",
                Progress {
                    model_id: model_id.clone(),
                    received,
                    total,
                    bytes_per_sec: (((received - existing) as f64) / elapsed) as u64,
                    done: false,
                },
            );
        }
    }
    file.flush().await?;
    drop(file);

    if sha256.is_empty() {
        tracing::warn!("{model_id} downloaded WITHOUT checksum verification");
    } else {
        let actual = format!("{:x}", hasher.finalize());
        if !actual.eq_ignore_ascii_case(&sha256) {
            let _ = tokio::fs::remove_file(&part_path).await;
            return Err(DownloadError::Checksum {
                expected: sha256,
                actual,
            });
        }
    }

    tokio::fs::rename(&part_path, &final_path).await?;
    let _ = app.emit(
        "download://progress",
        Progress {
            model_id,
            received,
            total,
            bytes_per_sec: 0,
            done: true,
        },
    );
    Ok(final_path)
}

/// Models already on disk, by file name.
pub fn installed() -> Vec<(String, u64)> {
    let dir = crate::paths::models_dir();
    let Ok(rd) = std::fs::read_dir(&dir) else {
        return Vec::new();
    };
    rd.filter_map(|e| e.ok())
        .filter(|e| e.path().extension().is_some_and(|x| x == "gguf"))
        .filter_map(|e| {
            let name = e.file_name().to_string_lossy().to_string();
            let size = e.metadata().ok()?.len();
            Some((name, size))
        })
        .collect()
}

pub fn remove(file_name: &str) -> std::io::Result<()> {
    let path = crate::paths::models_dir().join(file_name);
    // Refuse anything that escapes the models directory.
    if !path.starts_with(crate::paths::models_dir()) || file_name.contains("..") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "bad file name",
        ));
    }
    std::fs::remove_file(path)
}

pub fn path_of(file_name: &str) -> PathBuf {
    crate::paths::models_dir().join(file_name)
}
