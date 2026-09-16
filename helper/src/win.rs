//! Windows 10+ process tree, Job Object kill, thread suspend, and NT locks.

use super::process::{ProcessInfo, TreeSnapshot};
use anyhow::{bail, Result};
use std::collections::HashSet;
use std::path::Path;
use std::thread;
use std::time::Duration;
use windows_sys::Win32::Foundation::{CloseHandle, GetLastError, BOOL, FALSE, HANDLE, INVALID_HANDLE_VALUE};
use windows_sys::Win32::Storage::FileSystem::{
    CreateFileW, GetFileAttributesW, LockFileEx, SetFileAttributesW, UnlockFileEx, FILE_ATTRIBUTE_NORMAL,
    FILE_ATTRIBUTE_READONLY, FILE_SHARE_READ, FILE_SHARE_WRITE, LOCKFILE_EXCLUSIVE_LOCK, OPEN_ALWAYS,
};
use windows_sys::Win32::System::Diagnostics::ToolHelp::{
    CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, Thread32First, Thread32Next,
    PROCESSENTRY32W, THREADENTRY32, TH32CS_SNAPPROCESS, TH32CS_SNAPTHREAD,
};
use windows_sys::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject, TerminateJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};
use windows_sys::Win32::System::Threading::{
    GetCurrentProcessId, GetExitCodeProcess, OpenProcess, OpenThread, ResumeThread, SuspendThread,
    TerminateProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
    THREAD_SUSPEND_RESUME,
};

struct Handle(HANDLE);

impl Drop for Handle {
    fn drop(&mut self) {
        if !invalid(self.0) {
            unsafe { CloseHandle(self.0) };
            self.0 = INVALID_HANDLE_VALUE;
        }
    }
}

const STILL_ACTIVE: u32 = 259;
const GENERIC_READ: u32 = 0x8000_0000;
const GENERIC_WRITE: u32 = 0x4000_0000;

fn invalid(h: HANDLE) -> bool {
    h == INVALID_HANDLE_VALUE || h as usize == 0
}

fn last_error() -> std::io::Error {
    std::io::Error::from_raw_os_error(unsafe { GetLastError() } as i32)
}

pub fn pid_alive(pid: u32) -> bool {
    if pid == 0 || pid == 4 {
        return false;
    }
    unsafe {
        let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
        if invalid(handle) {
            return false;
        }
        let _guard = Handle(handle);
        let mut code = 0u32;
        if GetExitCodeProcess(handle, &mut code) == 0 {
            return false;
        }
        code == STILL_ACTIVE
    }
}

pub fn list_processes() -> Result<Vec<ProcessInfo>> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if invalid(snap) {
            bail!("CreateToolhelp32Snapshot failed: {}", last_error());
        }
        let _guard = Handle(snap);
        let mut entry = std::mem::zeroed::<PROCESSENTRY32W>();
        entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
        if Process32FirstW(snap, &mut entry) == 0 {
            bail!("Process32FirstW failed: {}", last_error());
        }
        let mut out = Vec::new();
        loop {
            if entry.th32ProcessID != 0 {
                out.push(ProcessInfo {
                    pid: entry.th32ProcessID,
                    ppid: entry.th32ParentProcessID,
                    command: utf16_cstr(&entry.szExeFile),
                });
            }
            if Process32NextW(snap, &mut entry) == 0 {
                break;
            }
        }
        Ok(out)
    }
}

fn utf16_cstr(buf: &[u16]) -> String {
    let len = buf.iter().position(|c| *c == 0).unwrap_or(buf.len());
    String::from_utf16_lossy(&buf[..len])
}

fn open_process(pid: u32, access: u32) -> Result<Handle> {
    unsafe {
        let handle = OpenProcess(access, FALSE, pid);
        if invalid(handle) {
            bail!("OpenProcess({pid}) failed: {}", last_error());
        }
        Ok(Handle(handle))
    }
}

fn terminate_pid(pid: u32) -> Result<()> {
    if pid == 0 || pid == 4 || pid == unsafe { GetCurrentProcessId() } {
        bail!("refusing to terminate pid {pid}");
    }
    let handle = open_process(pid, PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION)?;
    unsafe {
        if TerminateProcess(handle.0, 1) == 0 && pid_alive(pid) {
            bail!("TerminateProcess({pid}) failed: {}", last_error());
        }
    }
    Ok(())
}

fn assign_to_job(job: HANDLE, pid: u32) -> BOOL {
    let access = PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_LIMITED_INFORMATION;
    match open_process(pid, access) {
        Ok(handle) => unsafe { AssignProcessToJobObject(job, handle.0) },
        Err(_) => FALSE,
    }
}

pub fn kill_tree(root: u32, processes: Vec<ProcessInfo>) -> Result<TreeSnapshot> {
    let mut pids: Vec<u32> = processes.iter().map(|p| p.pid).collect();
    if !pids.contains(&root) {
        pids.push(root);
    }
    pids.sort_unstable();
    pids.dedup();
    pids.retain(|pid| *pid != 0 && *pid != 4 && *pid != unsafe { GetCurrentProcessId() });

    unsafe {
        let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
        if invalid(job) {
            bail!("CreateJobObjectW failed: {}", last_error());
        }
        let job = Handle(job);
        let mut info = std::mem::zeroed::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let ok = SetInformationJobObject(
            job.0,
            JobObjectExtendedLimitInformation,
            &info as *const _ as *const core::ffi::c_void,
            std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
        );
        if ok == 0 {
            bail!("SetInformationJobObject failed: {}", last_error());
        }
        for pid in &pids {
            let _ = assign_to_job(job.0, *pid);
        }
        let _ = TerminateJobObject(job.0, 1);
    }

    for pid in pids.iter().rev() {
        let _ = terminate_pid(*pid);
    }
    Ok(TreeSnapshot {
        root,
        processes: super::process::descendants(root, &list_processes().unwrap_or_default()),
        alive: pid_alive(root),
    })
}

fn for_each_thread(pids: &HashSet<u32>, mut visit: impl FnMut(u32) -> Result<()>) -> Result<()> {
    unsafe {
        let snap = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
        if invalid(snap) {
            bail!("CreateToolhelp32Snapshot(thread) failed: {}", last_error());
        }
        let _guard = Handle(snap);
        let mut entry = std::mem::zeroed::<THREADENTRY32>();
        entry.dwSize = std::mem::size_of::<THREADENTRY32>() as u32;
        if Thread32First(snap, &mut entry) == 0 {
            bail!("Thread32First failed: {}", last_error());
        }
        loop {
            if pids.contains(&entry.th32OwnerProcessID) && entry.th32ThreadID != 0 {
                visit(entry.th32ThreadID)?;
            }
            if Thread32Next(snap, &mut entry) == 0 {
                break;
            }
        }
    }
    Ok(())
}

fn set_threads(root: u32, processes: &[ProcessInfo], suspend: bool) -> Result<TreeSnapshot> {
    let mut pids: HashSet<u32> = processes.iter().map(|p| p.pid).collect();
    pids.insert(root);
    pids.remove(&unsafe { GetCurrentProcessId() });
    for_each_thread(&pids, |tid| {
        unsafe {
            let handle = OpenThread(THREAD_SUSPEND_RESUME, FALSE, tid);
            if invalid(handle) {
                return Ok(());
            }
            let _guard = Handle(handle);
            let rc = if suspend { SuspendThread(handle) } else { ResumeThread(handle) };
            if rc == u32::MAX {
                return Ok(());
            }
        }
        Ok(())
    })?;
    Ok(TreeSnapshot {
        root,
        processes: processes.to_vec(),
        alive: pid_alive(root),
    })
}

pub fn pause_tree(root: u32, processes: Vec<ProcessInfo>) -> Result<TreeSnapshot> {
    set_threads(root, &processes, true)
}

pub fn resume_tree(root: u32, processes: Vec<ProcessInfo>) -> Result<TreeSnapshot> {
    set_threads(root, &processes, false)
}

fn to_wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(std::iter::once(0)).collect()
}

pub fn hold_lock(path: &Path, duration_ms: u64) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let wide = to_wide(path);
    unsafe {
        let handle = CreateFileW(
            wide.as_ptr(),
            GENERIC_READ | GENERIC_WRITE,
            FILE_SHARE_READ | FILE_SHARE_WRITE,
            std::ptr::null(),
            OPEN_ALWAYS,
            FILE_ATTRIBUTE_NORMAL,
            std::ptr::null_mut(),
        );
        if invalid(handle) {
            bail!("CreateFileW failed: {}", last_error());
        }
        let _guard = Handle(handle);
        let mut overlapped = std::mem::zeroed();
        if LockFileEx(handle, LOCKFILE_EXCLUSIVE_LOCK, 0, u32::MAX, u32::MAX, &mut overlapped) == 0 {
            bail!("LockFileEx failed: {}", last_error());
        }
        thread::sleep(Duration::from_millis(duration_ms.max(1)));
        let mut unlock_over = std::mem::zeroed();
        let _ = UnlockFileEx(handle, 0, u32::MAX, u32::MAX, &mut unlock_over);
    }
    Ok(())
}

pub fn apply_mode(path: &Path, mode: &str) -> Result<()> {
    let bits = u32::from_str_radix(mode.trim_start_matches(['0', 'o']), 8).unwrap_or(0);
    let wide = to_wide(path);
    unsafe {
        let mut attrs = windows_sys::Win32::Storage::FileSystem::GetFileAttributesW(wide.as_ptr());
        if attrs == u32::MAX {
            bail!("GetFileAttributesW failed: {}", last_error());
        }
        if (bits & 0o222) == 0 {
            attrs |= FILE_ATTRIBUTE_READONLY;
        } else {
            attrs &= !FILE_ATTRIBUTE_READONLY;
        }
        if SetFileAttributesW(wide.as_ptr(), attrs) == 0 {
            bail!("SetFileAttributesW failed: {}", last_error());
        }
    }
    Ok(())
}

/// Spawn argv on a ConPTY. Handshake JSON goes to stderr; then stdout is the console stream.
pub fn run_conpty(cwd: Option<&Path>, extra_env: &[(String, String)], argv: &[String]) -> Result<i32> {
    use std::os::windows::io::{FromRawHandle, RawHandle};
    use windows_sys::Win32::Foundation::{SetHandleInformation, TRUE, HANDLE_FLAG_INHERIT};
    use windows_sys::Win32::System::Console::{ClosePseudoConsole, CreatePseudoConsole, COORD, HPCON};
    use windows_sys::Win32::System::Pipes::CreatePipe;
    use windows_sys::Win32::System::Threading::{
        CreateProcessW, DeleteProcThreadAttributeList, GetExitCodeProcess, InitializeProcThreadAttributeList,
        UpdateProcThreadAttribute, WaitForSingleObject, CREATE_UNICODE_ENVIRONMENT, EXTENDED_STARTUPINFO_PRESENT,
        PROCESS_INFORMATION, STARTUPINFOEXW, STARTUPINFOW,
    };
    use windows_sys::Win32::Security::SECURITY_ATTRIBUTES;

    const PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE: usize = 0x0002_0016;
    const INFINITE: u32 = 0xFFFF_FFFF;

    if argv.is_empty() {
        bail!("pty-spawn requires an executable");
    }
    for (key, value) in extra_env {
        std::env::set_var(key, value);
    }

    unsafe {
        let mut sa = SECURITY_ATTRIBUTES {
            nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
            lpSecurityDescriptor: std::ptr::null_mut(),
            bInheritHandle: TRUE,
        };
        let mut pty_in = INVALID_HANDLE_VALUE;
        let mut pipe_in = INVALID_HANDLE_VALUE;
        if CreatePipe(&mut pty_in, &mut pipe_in, &mut sa, 0) == 0 {
            bail!("CreatePipe input failed: {}", last_error());
        }
        let mut pipe_out = INVALID_HANDLE_VALUE;
        let mut pty_out = INVALID_HANDLE_VALUE;
        if CreatePipe(&mut pipe_out, &mut pty_out, &mut sa, 0) == 0 {
            bail!("CreatePipe output failed: {}", last_error());
        }
        if SetHandleInformation(pipe_in, HANDLE_FLAG_INHERIT, 0) == 0
            || SetHandleInformation(pipe_out, HANDLE_FLAG_INHERIT, 0) == 0
        {
            bail!("SetHandleInformation failed: {}", last_error());
        }

        let size = COORD { X: 80, Y: 25 };
        let mut hpcon: HPCON = 0;
        let hr = CreatePseudoConsole(size, pty_in, pty_out, 0, &mut hpcon);
        if hr != 0 {
            bail!("CreatePseudoConsole failed HRESULT=0x{hr:08X}");
        }
        CloseHandle(pty_in);
        CloseHandle(pty_out);

        let mut attr_bytes: usize = 0;
        InitializeProcThreadAttributeList(std::ptr::null_mut(), 1, 0, &mut attr_bytes);
        let mut attr_buf = vec![0u8; attr_bytes];
        let attr_list = attr_buf.as_mut_ptr().cast();
        if InitializeProcThreadAttributeList(attr_list, 1, 0, &mut attr_bytes) == 0 {
            ClosePseudoConsole(hpcon);
            bail!("InitializeProcThreadAttributeList failed: {}", last_error());
        }
        if UpdateProcThreadAttribute(
            attr_list,
            0,
            PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
            hpcon as *mut _,
            std::mem::size_of::<HPCON>(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        ) == 0
        {
            DeleteProcThreadAttributeList(attr_list);
            ClosePseudoConsole(hpcon);
            bail!("UpdateProcThreadAttribute failed: {}", last_error());
        }

        let mut si: STARTUPINFOEXW = std::mem::zeroed();
        si.StartupInfo.cb = std::mem::size_of::<STARTUPINFOEXW>() as u32;
        si.lpAttributeList = attr_list;

        let mut pi: PROCESS_INFORMATION = std::mem::zeroed();
        let mut cmdline_buf = wide_cmdline(argv);
        let app = wide(argv[0]);
        let dir = cwd.map(wide_path);
        let dir_ptr = dir.as_ref().map(|d| d.as_ptr()).unwrap_or(std::ptr::null());
        let created = CreateProcessW(
            app.as_ptr(),
            cmdline_buf.as_mut_ptr(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            TRUE,
            EXTENDED_STARTUPINFO_PRESENT | CREATE_UNICODE_ENVIRONMENT,
            std::ptr::null_mut(),
            dir_ptr,
            &si.StartupInfo as *const STARTUPINFOW as *mut STARTUPINFOW,
            &mut pi,
        );
        DeleteProcThreadAttributeList(attr_list);
        if created == 0 {
            ClosePseudoConsole(hpcon);
            bail!("CreateProcessW failed: {}", last_error());
        }
        CloseHandle(pi.hThread);

        crate::pty::write_ready(pi.dwProcessId)?;

        let mut writer = std::fs::File::from_raw_handle(pipe_in as RawHandle);
        std::thread::spawn(move || {
            let mut stdin = std::io::stdin();
            let mut buf = [0u8; 4096];
            loop {
                match std::io::Read::read(&mut stdin, &mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        if std::io::Write::write_all(&mut writer, &buf[..n]).is_err() {
                            break;
                        }
                    }
                }
            }
        });
        let mut reader = std::fs::File::from_raw_handle(pipe_out as RawHandle);
        let mut stdout = std::io::stdout();
        let mut buf = [0u8; 4096];
        loop {
            match std::io::Read::read(&mut reader, &mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = std::io::Write::write_all(&mut stdout, &buf[..n]);
                    let _ = std::io::Write::flush(&mut stdout);
                }
                Err(_) => break,
            }
        }

        WaitForSingleObject(pi.hProcess, INFINITE);
        let mut code = 1u32;
        let _ = GetExitCodeProcess(pi.hProcess, &mut code);
        CloseHandle(pi.hProcess);
        ClosePseudoConsole(hpcon);
        Ok(code as i32)
    }
}

fn wide(text: &str) -> Vec<u16> {
    text.encode_utf16().chain(std::iter::once(0)).collect()
}

fn wide_path(path: &Path) -> Vec<u16> {
    wide(&path.to_string_lossy())
}

fn wide_cmdline(argv: &[String]) -> Vec<u16> {
    let line = argv
        .iter()
        .map(|arg| {
            if arg.contains([' ', '\t', '"']) {
                format!("\"{}\"", arg.replace('"', "\\\""))
            } else {
                arg.clone()
            }
        })
        .collect::<Vec<_>>()
        .join(" ");
    wide(&line)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn list_includes_self() {
        let me = std::process::id();
        let all = list_processes().unwrap();
        assert!(all.iter().any(|p| p.pid == me));
    }

    #[test]
    fn kill_cmd_ping() {
        let mut child = Command::new("cmd")
            .args(["/C", "ping", "-n", "20", "127.0.0.1"])
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .spawn()
            .unwrap();
        let pid = child.id();
        thread::sleep(Duration::from_millis(200));
        let snap = crate::process::kill_tree(pid).unwrap();
        let _ = child.wait();
        assert!(!snap.alive);
        assert!(!pid_alive(pid));
    }
}
