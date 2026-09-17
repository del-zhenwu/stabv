//! Spawn an agent on a Unix PTY or Windows ConPTY.
//! Control plane passes executable + args only; this module does not parse YAML.

use anyhow::{bail, Result};
use serde_json::json;
use std::io::Write;
use std::path::Path;

pub fn run_pty_spawn(
    cwd: Option<&Path>,
    extra_env: &[(String, String)],
    argv: &[String],
) -> Result<i32> {
    if argv.is_empty() {
        bail!("pty-spawn requires an executable");
    }
    #[cfg(unix)]
    {
        unix::run(cwd, extra_env, argv)
    }
    #[cfg(windows)]
    {
        crate::win::run_conpty(cwd, extra_env, argv)
    }
}

pub(crate) fn write_ready(pid: u32) -> Result<()> {
    let mut err = std::io::stderr();
    writeln!(err, "{}", json!({"ok": true, "pid": pid, "pty": true}))?;
    err.flush()?;
    Ok(())
}

#[cfg(unix)]
mod unix {
    use super::{write_ready, Result};
    use anyhow::{bail, Context};
    use std::fs::File;
    use std::io::{Read, Write};
    use std::os::unix::io::{FromRawFd, IntoRawFd};
    use std::path::Path;

    pub fn run(cwd: Option<&Path>, extra_env: &[(String, String)], argv: &[String]) -> Result<i32> {
        let (master_fd, slave_fd) = open_pty().context("open pty")?;
        let pid = unsafe { libc::fork() };
        if pid < 0 {
            bail!("fork failed: {}", std::io::Error::last_os_error());
        }
        if pid == 0 {
            unsafe {
                libc::close(master_fd);
            }
            if let Err(err) = child_exec(slave_fd, cwd, extra_env, argv) {
                eprintln!("pty child: {err}");
                unsafe { libc::_exit(127) };
            }
            unsafe { libc::_exit(127) };
        }
        unsafe {
            libc::close(slave_fd);
        }
        write_ready(pid as u32)?;
        relay(master_fd)?;
        Ok(wait_child(pid))
    }

    fn open_pty() -> Result<(i32, i32)> {
        unsafe {
            let master = libc::posix_openpt(libc::O_RDWR | libc::O_NOCTTY);
            if master < 0 {
                bail!("posix_openpt failed: {}", std::io::Error::last_os_error());
            }
            if libc::grantpt(master) != 0 {
                bail!("grantpt failed: {}", std::io::Error::last_os_error());
            }
            if libc::unlockpt(master) != 0 {
                bail!("unlockpt failed: {}", std::io::Error::last_os_error());
            }
            let slave_path = pts_name(master)?;
            let slave = libc::open(slave_path.as_ptr(), libc::O_RDWR | libc::O_NOCTTY);
            if slave < 0 {
                bail!("open slave pty failed: {}", std::io::Error::last_os_error());
            }
            Ok((master, slave))
        }
    }

    fn pts_name(master: i32) -> Result<std::ffi::CString> {
        static PTSNAME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = PTSNAME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        unsafe {
            let ptr = libc::ptsname(master);
            if ptr.is_null() {
                anyhow::bail!("ptsname failed: {}", std::io::Error::last_os_error());
            }
            Ok(std::ffi::CStr::from_ptr(ptr).to_owned())
        }
    }

    fn child_exec(
        slave_fd: i32,
        cwd: Option<&Path>,
        extra_env: &[(String, String)],
        argv: &[String],
    ) -> Result<()> {
        unsafe {
            if libc::setsid() < 0 {
                bail!("setsid failed: {}", std::io::Error::last_os_error());
            }
            if libc::ioctl(slave_fd, libc::TIOCSCTTY as libc::c_ulong, 0) < 0 {
                // Some environments refuse a controlling tty; still attach stdio.
            }
            if libc::dup2(slave_fd, 0) < 0
                || libc::dup2(slave_fd, 1) < 0
                || libc::dup2(slave_fd, 2) < 0
            {
                bail!("dup2 slave failed: {}", std::io::Error::last_os_error());
            }
            if slave_fd > 2 {
                libc::close(slave_fd);
            }
        }
        if let Some(dir) = cwd {
            std::env::set_current_dir(dir).with_context(|| format!("chdir {}", dir.display()))?;
        }
        for (key, value) in extra_env {
            std::env::set_var(key, value);
        }
        let exe = std::ffi::CString::new(argv[0].as_str()).context("executable")?;
        let args: Vec<std::ffi::CString> = argv
            .iter()
            .map(|s| std::ffi::CString::new(s.as_str()).context("arg"))
            .collect::<Result<Vec<_>>>()?;
        let mut ptrs: Vec<*const libc::c_char> = args.iter().map(|s| s.as_ptr()).collect();
        ptrs.push(std::ptr::null());
        unsafe {
            libc::execvp(exe.as_ptr(), ptrs.as_ptr());
        }
        bail!(
            "execvp {} failed: {}",
            argv[0],
            std::io::Error::last_os_error()
        );
    }

    fn relay(master_fd: i32) -> Result<()> {
        let mut master = unsafe { File::from_raw_fd(master_fd) };
        let mut master_in = master.try_clone().context("clone pty master")?;
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 4096];
            loop {
                match stdin.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if master_in.write_all(&buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let mut stdout = std::io::stdout();
        let mut buf = [0u8; 4096];
        loop {
            match master.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    stdout.write_all(&buf[..n])?;
                    stdout.flush()?;
                }
                Err(err) if err.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            }
        }
        let _ = master.into_raw_fd();
        Ok(())
    }

    fn wait_child(pid: libc::pid_t) -> i32 {
        let mut status = 0;
        unsafe {
            libc::waitpid(pid, &mut status, 0);
            if libc::WIFEXITED(status) {
                libc::WEXITSTATUS(status)
            } else if libc::WIFSIGNALED(status) {
                128 + libc::WTERMSIG(status)
            } else {
                1
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    #[test]
    fn echo_through_pty_exits_zero() {
        let code =
            super::run_pty_spawn(None, &[], &["/bin/echo".into(), "ok".into()]).expect("pty echo");
        assert_eq!(code, 0);
    }
}
