//! Real desktop UI bridge. The bridge deliberately returns platform/API errors;
//! it never reports a successful UI action when permissions or a window are absent.

use anyhow::{bail, Context, Result};

pub fn close_window(pid: u32) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"System Events\"\n  tell (first application process whose unix id is {pid})\n    if (count of windows) is 0 then error \"process has no windows\"\n    close front window\n  end tell\nend tell"
        );
        let output = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", script.as_str()])
            .output()
            .context("failed to invoke macOS Accessibility bridge (osascript)")?;
        if !output.status.success() {
            bail!(
                "macOS Accessibility close failed for pid {pid}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        return Ok(());
    }

    #[cfg(windows)]
    {
        let script = format!(
            "Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes; $p=Get-Process -Id {pid} -ErrorAction Stop; $h=$p.MainWindowHandle; if ($h -eq 0) {{ throw 'process has no main window' }}; $e=[System.Windows.Automation.AutomationElement]::FromHandle($h); $pat=$null; if (-not $e.TryGetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern, [ref]$pat)) {{ throw 'window does not expose WindowPattern' }}; $pat.Close()"
        );
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script.as_str(),
            ])
            .output()
            .context("failed to invoke Windows UI Automation bridge (powershell.exe)")?;
        if !output.status.success() {
            bail!(
                "Windows UI Automation close failed for pid {pid}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = pid;
        bail!("desktop UI bridge is unsupported on this platform");
    }
}

pub fn send_text(pid: u32, text: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let escaped = applescript_string(text);
        let script = format!(
            "tell application \"System Events\"\n  tell (first application process whose unix id is {pid})\n    set frontmost to true\n    keystroke {escaped}\n  end tell\nend tell"
        );
        let output = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", script.as_str()])
            .output()
            .context("failed to invoke macOS Accessibility input bridge (osascript)")?;
        if !output.status.success() {
            bail!(
                "macOS Accessibility text input failed for pid {pid}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        return Ok(());
    }

    #[cfg(windows)]
    {
        let escaped = text.replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName Microsoft.VisualBasic, System.Windows.Forms; $p=Get-Process -Id {pid} -ErrorAction Stop; if ($p.MainWindowHandle -eq 0) {{ throw 'process has no main window' }}; [Microsoft.VisualBasic.Interaction]::AppActivate($p.Id); [System.Windows.Forms.SendKeys]::SendWait('{escaped}')"
        );
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script.as_str(),
            ])
            .output()
            .context("failed to invoke Windows UI input bridge (powershell.exe)")?;
        if !output.status.success() {
            bail!(
                "Windows UI Automation text input failed for pid {pid}: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        return Ok(());
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (pid, text);
        bail!("desktop UI bridge is unsupported on this platform");
    }
}

#[cfg(target_os = "macos")]
fn applescript_string(text: &str) -> String {
    format!("\"{}\"", text.replace('\\', "\\\\").replace('"', "\\\""))
}

pub fn take_screenshot(path: &std::path::Path) -> Result<std::path::PathBuf> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(target_os = "macos")]
    {
        let target_str = path.to_str().unwrap_or("screenshot.png");
        let mut last_err = String::new();
        for attempt in 0..3 {
            let output = std::process::Command::new("/usr/sbin/screencapture")
                .args(["-x", target_str])
                .output()
                .context("failed to invoke macOS screencapture")?;
            if output.status.success() {
                return Ok(path.to_path_buf());
            }
            last_err = String::from_utf8_lossy(&output.stderr).trim().to_string();
            if attempt < 2 {
                std::thread::sleep(std::time::Duration::from_millis(150));
            }
        }
        bail!("macOS screencapture failed: {}", last_err);
    }

    #[cfg(windows)]
    {
        let path_str = path.to_string_lossy().replace('\'', "''");
        let script = format!(
            "Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b = New-Object System.Drawing.Bitmap([System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Width, [System.Windows.Forms.Screen]::PrimaryScreen.Bounds.Height); $g = [System.Drawing.Graphics]::FromImage($b); $g.CopyFromScreen((New-Object System.Drawing.Point(0,0)), (New-Object System.Drawing.Point(0,0)), $b.Size); $b.Save('{path_str}', [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $b.Dispose()"
        );
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script.as_str(),
            ])
            .output()
            .context("failed to invoke Windows screenshot bridge (powershell.exe)")?;
        if !output.status.success() {
            bail!(
                "Windows screenshot failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        return Ok(path.to_path_buf());
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        bail!("screenshot bridge is unsupported on this platform");
    }
}

pub fn is_responsive(pid: u32) -> Result<bool> {
    #[cfg(target_os = "macos")]
    {
        let script = format!(
            "tell application \"System Events\"\n  set procs to (every application process whose unix id is {pid})\n  if (count of procs) is 0 then error \"process not found\"\n  return true\nend tell"
        );
        let output = std::process::Command::new("/usr/bin/osascript")
            .args(["-e", script.as_str()])
            .output();
        match output {
            Ok(o) => Ok(o.status.success()),
            Err(_) => Ok(false),
        }
    }

    #[cfg(windows)]
    {
        let script = format!(
            "$p = Get-Process -Id {pid} -ErrorAction SilentlyContinue; if ($null -eq $p) {{ return $false }}; return $p.Responding"
        );
        let output = std::process::Command::new("powershell.exe")
            .args([
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                script.as_str(),
            ])
            .output()?;
        let txt = String::from_utf8_lossy(&output.stdout).trim().to_lowercase();
        Ok(txt == "true")
    }

    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = pid;
        bail!("desktop responsiveness bridge is unsupported on this platform");
    }
}
