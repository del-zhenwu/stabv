use anyhow::Result;
use std::thread;
use std::time::{Duration, Instant};

pub fn cpu_stress(duration_ms: u64, threads: usize) -> Result<()> {
    let n = threads.max(1);
    let deadline = Instant::now() + Duration::from_millis(duration_ms.max(1));
    let handles: Vec<_> = (0..n)
        .map(|_| {
            thread::spawn(move || {
                let mut acc = 0u64;
                while Instant::now() < deadline {
                    acc = acc.wrapping_mul(1664525).wrapping_add(1013904223);
                    std::hint::black_box(acc);
                }
            })
        })
        .collect();
    for handle in handles {
        let _ = handle.join();
    }
    Ok(())
}

pub fn mem_stress(duration_ms: u64, mb: usize) -> Result<()> {
    let bytes = mb.max(1).saturating_mul(1024 * 1024);
    let mut blob = vec![0xA5u8; bytes];
    for (i, b) in blob.iter_mut().enumerate().step_by(4096) {
        *b = (i % 251) as u8;
    }
    thread::sleep(Duration::from_millis(duration_ms.max(1)));
    std::hint::black_box(blob[0]);
    Ok(())
}

pub fn disk_stress(duration_ms: u64, mb: usize, path: Option<&std::path::Path>) -> Result<()> {
    use std::io::Write;
    let target = match path {
        Some(p) => p.to_path_buf(),
        None => std::env::temp_dir().join(format!("agentchaos-disk-stress-{}", std::process::id())),
    };
    if let Some(parent) = target.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(&target)?;
    let chunk = vec![0x5Au8; 1024 * 1024];
    for _ in 0..mb.max(1) {
        file.write_all(&chunk)?;
    }
    file.sync_all()?;
    thread::sleep(Duration::from_millis(duration_ms.max(1)));
    let _ = std::fs::remove_file(&target);
    Ok(())
}

pub fn disk_exhaustion(duration_ms: u64, path: &std::path::Path, max_mb: Option<usize>) -> Result<u64> {
    use std::io::Write;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::File::create(path)?;
    let chunk = vec![0x5Au8; 1024 * 1024];
    let limit = max_mb.unwrap_or(64);
    let mut written: u64 = 0;
    for _ in 0..limit {
        match file.write_all(&chunk) {
            Ok(_) => written += 1024 * 1024,
            Err(_) => break,
        }
    }
    let _ = file.sync_all();
    thread::sleep(Duration::from_millis(duration_ms.max(1)));
    let _ = std::fs::remove_file(path);
    Ok(written)
}

#[cfg(unix)]
pub fn handle_stress(duration_ms: u64, limit: Option<usize>) -> Result<usize> {
    let mut files = Vec::new();
    let max = limit.unwrap_or(32768);
    for _ in 0..max {
        match std::fs::File::open("/dev/null") {
            Ok(f) => files.push(f),
            Err(e) => {
                if e.raw_os_error() == Some(libc::EMFILE) || e.raw_os_error() == Some(libc::ENFILE) {
                    break;
                }
                return Err(e.into());
            }
        }
    }
    let count = files.len();
    thread::sleep(Duration::from_millis(duration_ms.max(1)));
    drop(files);
    Ok(count)
}

#[cfg(windows)]
pub fn handle_stress(duration_ms: u64, limit: Option<usize>) -> Result<usize> {
    crate::win::handle_stress(duration_ms, limit)
}

#[cfg(unix)]
pub fn hold_flock(path: &std::path::Path, duration_ms: u64) -> Result<()> {
    use std::os::unix::io::AsRawFd;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .open(path)?;
    let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) };
    if rc != 0 {
        anyhow::bail!("flock failed: {}", std::io::Error::last_os_error());
    }
    thread::sleep(Duration::from_millis(duration_ms.max(1)));
    unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    Ok(())
}

#[cfg(windows)]
pub fn hold_flock(path: &std::path::Path, duration_ms: u64) -> Result<()> {
    crate::win::hold_lock(path, duration_ms)
}

#[cfg(windows)]
pub fn apply_mode(path: &std::path::Path, mode: &str) -> Result<()> {
    crate::win::apply_mode(path, mode)
}

#[cfg(unix)]
pub fn apply_mode(path: &std::path::Path, mode: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    let bits = u32::from_str_radix(mode.trim_start_matches(['0', 'o']), 8).unwrap_or(0);
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(bits))?;
    Ok(())
}
