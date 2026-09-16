mod process;
mod pty;
mod resource;
#[cfg(windows)]
mod win;

use anyhow::Result;
use clap::{Parser, Subcommand};
use serde::Serialize;
use std::path::PathBuf;

#[derive(Parser)]
#[command(name = "agentchaos-helper", about = "AgentChaos platform helper")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    Caps,
    /// Discover the process tree rooted at pid
    ListTree { pid: u32 },
    /// SIGKILL / Job Object terminate the process tree
    KillTree { pid: u32 },
    /// SIGSTOP (Unix) or SuspendThread (Windows)
    PauseTree { pid: u32 },
    /// SIGCONT (Unix) or ResumeThread (Windows)
    ResumeTree { pid: u32 },
    /// Busy-loop CPU pressure
    CpuStress {
        #[arg(long)]
        duration_ms: u64,
        #[arg(long, default_value_t = 2)]
        threads: usize,
    },
    /// Allocate memory for a duration
    MemStress {
        #[arg(long)]
        duration_ms: u64,
        #[arg(long, default_value_t = 64)]
        mb: usize,
    },
    /// Hold an exclusive flock / LockFileEx on a file
    Flock {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        duration_ms: u64,
    },
    /// Apply POSIX-like mode; on Windows this maps to the read-only attribute
    Acl {
        #[arg(long)]
        path: PathBuf,
        #[arg(long)]
        mode: String,
    },
    /// Spawn executable on a Unix PTY or Windows ConPTY and relay stdio.
    /// Handshake JSON is one line on stderr; afterwards stdout is the terminal stream.
    PtySpawn {
        #[arg(long)]
        cwd: Option<PathBuf>,
        /// Overlay KEY=VAL on the inherited environment
        #[arg(long, value_name = "KEY=VAL")]
        env: Vec<String>,
        #[arg(last = true, required = true)]
        argv: Vec<String>,
    },
}

#[derive(Serialize)]
struct Caps {
    ok: bool,
    name: &'static str,
    version: &'static str,
    platform: &'static str,
    min_os: &'static str,
    capabilities: Vec<&'static str>,
}

fn capabilities() -> Vec<&'static str> {
    let mut caps = vec![
        "list-tree",
        "kill-tree",
        "pause-tree",
        "resume-tree",
        "cpu-stress",
        "mem-stress",
        "flock",
        "acl",
        "pty",
    ];
    if cfg!(windows) {
        caps.push("job-object");
        caps.push("lockfileex");
        caps.push("conpty");
    }
    caps
}

fn print_json(value: impl Serialize) {
    println!("{}", serde_json::to_string(&value).expect("json"));
}

fn fail(err: impl std::fmt::Display) -> ! {
    print_json(serde_json::json!({"ok": false, "error": err.to_string()}));
    std::process::exit(1);
}

fn main() {
    if let Err(err) = run() {
        fail(err);
    }
}

fn run() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Caps => {
            print_json(Caps {
                ok: true,
                name: "agentchaos-helper",
                version: env!("CARGO_PKG_VERSION"),
                platform: std::env::consts::OS,
                min_os: if cfg!(windows) { "windows10" } else { "posix" },
                capabilities: capabilities(),
            });
        }
        Commands::ListTree { pid } => {
            let snap = process::snapshot(pid)?;
            print_json(serde_json::json!({"ok": true, "tree": snap}));
        }
        Commands::KillTree { pid } => {
            let snap = process::kill_tree(pid)?;
            print_json(serde_json::json!({"ok": true, "tree": snap}));
        }
        Commands::PauseTree { pid } => {
            let snap = process::pause_tree(pid)?;
            print_json(serde_json::json!({"ok": true, "tree": snap}));
        }
        Commands::ResumeTree { pid } => {
            let snap = process::resume_tree(pid)?;
            print_json(serde_json::json!({"ok": true, "tree": snap}));
        }
        Commands::CpuStress { duration_ms, threads } => {
            resource::cpu_stress(duration_ms, threads)?;
            print_json(serde_json::json!({"ok": true, "op": "cpu-stress", "duration_ms": duration_ms, "threads": threads}));
        }
        Commands::MemStress { duration_ms, mb } => {
            resource::mem_stress(duration_ms, mb)?;
            print_json(serde_json::json!({"ok": true, "op": "mem-stress", "duration_ms": duration_ms, "mb": mb}));
        }
        Commands::Flock { path, duration_ms } => {
            resource::hold_flock(&path, duration_ms)?;
            print_json(serde_json::json!({"ok": true, "op": "flock", "path": path, "duration_ms": duration_ms}));
        }
        Commands::Acl { path, mode } => {
            resource::apply_mode(&path, &mode)?;
            print_json(serde_json::json!({"ok": true, "op": "acl", "path": path, "mode": mode}));
        }
        Commands::PtySpawn { cwd, env, argv } => {
            let extra: Vec<(String, String)> = env
                .iter()
                .map(|item| {
                    let (key, value) = item.split_once('=').unwrap_or((item.as_str(), ""));
                    (key.to_string(), value.to_string())
                })
                .collect();
            let code = pty::run_pty_spawn(cwd.as_deref(), &extra, &argv)?;
            std::process::exit(code);
        }
    }
    Ok(())
}
