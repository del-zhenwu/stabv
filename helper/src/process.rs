use anyhow::{bail, Context, Result};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};

#[derive(Debug, Clone, Serialize)]
pub struct ProcessInfo {
    pub pid: u32,
    pub ppid: u32,
    pub command: String,
}

#[derive(Debug, Serialize)]
pub struct TreeSnapshot {
    pub root: u32,
    pub processes: Vec<ProcessInfo>,
    pub alive: bool,
}

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as i32, 0) == 0
            || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
    }
    #[cfg(windows)]
    {
        crate::win::pid_alive(pid)
    }
}

pub fn list_processes() -> Result<Vec<ProcessInfo>> {
    #[cfg(unix)]
    {
        let output = std::process::Command::new("ps")
            .args(["-axo", "pid=,ppid=,command="])
            .output()
            .context("failed to run ps")?;
        if !output.status.success() {
            bail!("ps exited with {}", output.status);
        }
        parse_ps(&String::from_utf8_lossy(&output.stdout))
    }
    #[cfg(windows)]
    {
        crate::win::list_processes()
    }
}

pub fn parse_ps(text: &str) -> Result<Vec<ProcessInfo>> {
    let mut out = Vec::new();
    for line in text.lines() {
        let mut parts = line.split_whitespace();
        let Some(pid_s) = parts.next() else { continue };
        let Some(ppid_s) = parts.next() else { continue };
        let pid: u32 = pid_s.parse().unwrap_or(0);
        let ppid: u32 = ppid_s.parse().unwrap_or(0);
        let command = parts.collect::<Vec<_>>().join(" ");
        if pid == 0 {
            continue;
        }
        out.push(ProcessInfo { pid, ppid, command });
    }
    Ok(out)
}

pub fn descendants(root: u32, all: &[ProcessInfo]) -> Vec<ProcessInfo> {
    let mut by_parent: HashMap<u32, Vec<&ProcessInfo>> = HashMap::new();
    for proc in all {
        by_parent.entry(proc.ppid).or_default().push(proc);
    }
    let mut seen = HashSet::from([root]);
    let mut q = VecDeque::from([root]);
    let mut out = Vec::new();
    if let Some(self_proc) = all.iter().find(|p| p.pid == root) {
        out.push(self_proc.clone());
    } else {
        out.push(ProcessInfo {
            pid: root,
            ppid: 0,
            command: String::new(),
        });
    }
    while let Some(pid) = q.pop_front() {
        for child in by_parent.get(&pid).into_iter().flatten() {
            if seen.insert(child.pid) {
                out.push((*child).clone());
                q.push_back(child.pid);
            }
        }
    }
    out
}

pub fn snapshot(root: u32) -> Result<TreeSnapshot> {
    let all = list_processes()?;
    Ok(TreeSnapshot {
        root,
        processes: descendants(root, &all),
        alive: pid_alive(root),
    })
}

#[cfg(unix)]
fn signal_pid(pid: u32, sig: i32) -> Result<()> {
    if pid == 0 || pid == 1 {
        bail!("refusing to signal pid {pid}");
    }
    #[cfg(unix)]
    unsafe {
        if libc::kill(pid as i32, sig) != 0 {
            let err = std::io::Error::last_os_error();
            if err.raw_os_error() != Some(libc::ESRCH) {
                bail!("kill({pid}, {sig}) failed: {err}");
            }
        }
    }
    Ok(())
}

pub fn kill_process(pid: u32) -> Result<()> {
    #[cfg(unix)]
    {
        signal_pid(pid, libc::SIGKILL)
    }
    #[cfg(windows)]
    {
        crate::win::kill_single(pid)
    }
}

pub fn kill_tree(root: u32) -> Result<TreeSnapshot> {
    #[cfg(unix)]
    {
        signal_tree(root, libc::SIGKILL)
    }
    #[cfg(windows)]
    {
        let snap = snapshot(root)?;
        crate::win::kill_tree(root, snap.processes)
    }
}

pub fn pause_tree(root: u32) -> Result<TreeSnapshot> {
    #[cfg(unix)]
    {
        signal_tree(root, libc::SIGSTOP)
    }
    #[cfg(windows)]
    {
        let snap = snapshot(root)?;
        crate::win::pause_tree(root, snap.processes)
    }
}

pub fn resume_tree(root: u32) -> Result<TreeSnapshot> {
    #[cfg(unix)]
    {
        signal_tree(root, libc::SIGCONT)
    }
    #[cfg(windows)]
    {
        let snap = snapshot(root)?;
        crate::win::resume_tree(root, snap.processes)
    }
}

#[cfg(unix)]
fn signal_tree(root: u32, sig: i32) -> Result<TreeSnapshot> {
    let snap = snapshot(root)?;
    let mut pids: Vec<u32> = snap.processes.iter().map(|p| p.pid).collect();
    pids.sort_unstable();
    pids.dedup();
    pids.retain(|pid| *pid != 0 && *pid != 1);
    pids.reverse();
    for pid in &pids {
        let _ = signal_pid(*pid, sig);
    }
    unsafe {
        if sig == libc::SIGKILL {
            let _ = libc::kill(-(root as i32), sig);
        }
    }
    Ok(snapshot(root).unwrap_or(snap))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ps_lines() {
        let procs = parse_ps("  1     0 /sbin/launchd\n  42    1 sleep 30\n").unwrap();
        assert_eq!(procs.len(), 2);
        assert_eq!(procs[1].pid, 42);
        assert_eq!(procs[1].ppid, 1);
    }

    #[test]
    fn walk_descendants() {
        let all = vec![
            ProcessInfo {
                pid: 10,
                ppid: 1,
                command: "root".into(),
            },
            ProcessInfo {
                pid: 11,
                ppid: 10,
                command: "child".into(),
            },
            ProcessInfo {
                pid: 12,
                ppid: 11,
                command: "grand".into(),
            },
            ProcessInfo {
                pid: 99,
                ppid: 1,
                command: "other".into(),
            },
        ];
        let tree = descendants(10, &all);
        let pids: Vec<u32> = tree.iter().map(|p| p.pid).collect();
        assert_eq!(pids, vec![10, 11, 12]);
    }
}
